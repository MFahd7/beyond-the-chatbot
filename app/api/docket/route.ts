/**
 * Build the docket.
 *
 * One route does the whole job. The operator model arrives in the request, the
 * docket is derived from it, and nothing is kept between calls -- so this is a
 * pure function of (corpus, weights, model, clock) that happens to be reachable
 * over HTTP. Feedback is applied on the client, against the same
 * `core/operator.ts` module this file's neighbours use, and the resulting model
 * is posted back here to see what it changed.
 *
 * That arrangement is why the interface can promise a reordering the operator
 * can watch happen: there is no hidden server state that could disagree with
 * what the screen is showing.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'

import { buildDocket } from '@/core/docket'
import { emptyModel } from '@/core/operator'
import { snippet } from '@/core/text'
import { ageOf } from '@/core/rules'
import type { Case, Corpus, EvalReport, Issue, Weights } from '@/core/types'
import type {
  DocketRequest,
  DocketResponse,
  WireBacklogRow,
  WireCase,
  WireIssue,
  WireSignal,
} from '@/app/api-types'

export const dynamic = 'force-dynamic'

/** How many issues a card carries. A sweep of 115 does not send 115 bodies. */
const MAX_ISSUES_PER_CARD = 8
/** How many drafted calls the card shows before summarising the rest. */
const MAX_MUTATIONS_SHOWN = 4
/** Rows in the comparison pane. Enough to feel the length of the real list. */
const BACKLOG_ROWS = 60

let cache: { corpus: Corpus; weights: Weights; evaluation: EvalReport } | null = null

/**
 * Read and hold the corpus. 9 MB of JSON parses in well under a second but
 * there is no reason to do it twice, and on a warm serverless instance this
 * makes the whole request essentially free.
 */
async function load() {
  if (cache) return cache
  const dir = path.join(process.cwd(), 'data')
  const [corpus, weights, evaluation] = await Promise.all([
    readFile(path.join(dir, 'corpus.json'), 'utf8').then((t) => JSON.parse(t) as Corpus),
    readFile(path.join(dir, 'weights.json'), 'utf8').then((t) => JSON.parse(t) as Weights),
    readFile(path.join(dir, 'eval.json'), 'utf8').then((t) => JSON.parse(t) as EvalReport),
  ])
  cache = { corpus, weights, evaluation }
  return cache
}

function wireIssue(issue: Issue, corpus: Corpus, now: Date): WireIssue {
  const template = corpus.templates[issue.number]
  const { age, idle } = ageOf(issue, now)
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    reactions: issue.reactions,
    comments: issue.comments,
    ageDays: age,
    idleDays: idle,
    version: template?.nextVersion ?? null,
    areas: template?.declared ?? [],
    snippet: snippet(issue.body, 180),
  }
}

function wireCase(kase: Case, corpus: Corpus, now: Date): WireCase {
  // When a model decided this, pair each displayed signal with the weight and
  // push that made it matter. Without those two numbers the evidence panel is
  // a list of facts; with them it is an explanation.
  const winner = kase.inference.scores.find((s) => s.intent === kase.inference.top)
  const contributions = new Map((winner?.contributions ?? []).map((c) => [c.signalId, c]))

  const signals: WireSignal[] = kase.signals.map((signal) => {
    const contribution = contributions.get(signal.id)
    return {
      id: signal.id,
      kind: signal.kind,
      label: signal.label,
      value: signal.value,
      confidence: signal.confidence,
      evidence: signal.evidence,
      ...(contribution ? { weight: contribution.weight, push: contribution.push } : {}),
    }
  })

  return {
    id: kase.id,
    kind: kase.kind,
    headline: kase.headline,
    situation: kase.situation,
    confidence: kase.inference.confidence,
    margin: kase.inference.margin,
    deadEnd: kase.inference.deadEnd,
    ev: kase.ev,
    impact: kase.impact,
    impactUnit: kase.impactUnit,
    effort: kase.effort,
    autoAfter: kase.autoAfter,
    explain: kase.explain,
    provenance: kase.provenance,
    signals,
    action: {
      summary: kase.action.summary,
      reversal: kase.action.reversal,
      reversibility: kase.action.reversibility,
      mutations: kase.action.mutations.slice(0, MAX_MUTATIONS_SHOWN).map((m) => ({
        kind: m.kind,
        issue: m.issue,
        payload: m.payload,
        request: m.request,
        stage: m.stage,
      })),
      total: kase.action.mutations.length,
      autonomous: kase.action.autonomous.length,
    },
    issues: kase.issues
      .slice(0, MAX_ISSUES_PER_CARD)
      .map((issue) => wireIssue(issue, corpus, now)),
    alternatives: kase.inference.scores
      .filter((s) => s.intent !== kase.inference.top)
      .map((s) => ({ intent: s.intent, probability: s.probability })),
    sweep: kase.sweep
      ? { count: kase.sweep.count, basis: kase.sweep.basis, autoCount: kase.sweep.autoCount }
      : null,
  }
}

export async function POST(request: Request) {
  const { corpus, weights, evaluation } = await load()

  let body: DocketRequest = {}
  try {
    body = (await request.json()) as DocketRequest
  } catch {
    // An empty body is a fresh operator, which is the common case on load.
  }

  const model = body.model ?? emptyModel()
  // The corpus has a build date. Using it as the default clock keeps the
  // demo's "quiet for 274 days" honest rather than drifting as the repo ages.
  const now = new Date(body.now ?? corpus.meta.builtAt)

  const { cases, suppressed, stats } = buildDocket({ corpus, weights, model, now })

  const backlog: WireBacklogRow[] = [...corpus.open]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, BACKLOG_ROWS)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      labels: issue.labels,
      comments: issue.comments,
      reactions: issue.reactions,
      ageDays: ageOf(issue, now).age,
      author: issue.author,
    }))

  const models = [
    { id: 'resolution', score: evaluation.resolution },
    ...Object.entries(evaluation.actions).map(([id, score]) => ({ id, score })),
  ].map(({ id, score }) => ({
    id,
    accuracy: score.accuracy,
    auc: score.auc,
    baseline: score.baseline,
    heldOut: score.heldOut,
    shipped: score.shipped,
    verdict: score.verdict,
  }))

  const response: DocketResponse = {
    cases: cases.map((kase) => wireCase(kase, corpus, now)),
    suppressed: suppressed.slice(0, 400).map((s) => ({
      id: s.id,
      kind: s.kind,
      issues: s.issues,
      headline: s.headline,
      confidence: s.confidence,
      why: s.why,
    })),
    stats,
    backlog,
    meta: {
      repo: corpus.meta.repo,
      fetchedAt: corpus.meta.fetchedAt,
      builtAt: corpus.meta.builtAt,
      openIssues: corpus.meta.openCount,
      openReported: corpus.meta.openTotalReported,
      trainingRows: corpus.meta.trainingCount,
      vocabulary: corpus.meta.vocabulary,
      clusters: corpus.meta.clusterCount,
      models,
    },
    now: now.toISOString(),
  }

  return NextResponse.json(response)
}
