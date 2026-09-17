/**
 * Execute an approved decision.
 *
 * Two modes, and the interface behaves identically in both:
 *
 *   dry run (default)   Nothing leaves the process. The response reports every
 *                       request that would have been sent, and the operator
 *                       already reviewed those exact strings on the card.
 *
 *   live                With GITHUB_WRITE_TOKEN and DOCKET_TARGET_REPO set,
 *                       the same drafts execute against a repository the
 *                       operator owns.
 *
 * The drafts are rebuilt here from the case id rather than accepted from the
 * client. That is not ceremony: a sweep of 115 issues carries 230 mutations and
 * the card only ever received a sample of four, so the client does not have the
 * full set to send. Rebuilding also means the executed requests are the ones
 * the pure pipeline produced, not whatever arrived over the wire.
 *
 * WHY THE UPSTREAM REPOSITORY IS REFUSED OUTRIGHT
 *
 * The corpus is somebody else's bug tracker. 1,000 real people are waiting on
 * those issues, and a demo that can be pointed at them by setting one
 * environment variable is a demo that eventually is. So the target repo is
 * checked against the corpus repo and rejected, with no override flag. The
 * write path exists to prove the actions are real; it does not need to be
 * aimable at strangers to do that.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'

import { buildDocket } from '@/core/docket'
import { emptyModel } from '@/core/operator'
import type { Corpus, Mutation, OperatorModel, Weights } from '@/core/types'

export const dynamic = 'force-dynamic'

const UPSTREAM = 'vercel/next.js'

interface ApplyRequest {
  model?: OperatorModel
  caseId: string
  /** 'auto' executes only the self-applying subset; 'all' the whole draft. */
  scope?: 'auto' | 'all'
  now?: string
}

interface Executed {
  issue: number
  kind: string
  request: string
  status: 'dry-run' | 'sent' | 'failed'
  detail?: string
}

let cache: { corpus: Corpus; weights: Weights } | null = null

async function load() {
  if (cache) return cache
  const dir = path.join(process.cwd(), 'data')
  const [corpus, weights] = await Promise.all([
    readFile(path.join(dir, 'corpus.json'), 'utf8').then((t) => JSON.parse(t) as Corpus),
    readFile(path.join(dir, 'weights.json'), 'utf8').then((t) => JSON.parse(t) as Weights),
  ])
  cache = { corpus, weights }
  return cache
}

/** Turn one drafted mutation into a real request against the target repo. */
async function send(mutation: Mutation, repo: string, token: string): Promise<Executed> {
  const base = 'https://api.github.com/repos/' + repo + '/issues/' + mutation.issue
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    'User-Agent': 'docket',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  let url = base
  let method = 'POST'
  let body: unknown

  switch (mutation.kind) {
    case 'label':
      url = base + '/labels'
      body = { labels: mutation.payload.split(', ') }
      break
    case 'comment':
      url = base + '/comments'
      body = { body: mutation.payload }
      break
    case 'close':
      method = 'PATCH'
      body = { state: 'closed', state_reason: mutation.payload }
      break
    default:
      return {
        issue: mutation.issue,
        kind: mutation.kind,
        request: mutation.request,
        status: 'failed',
        detail: 'no write path implemented for ' + mutation.kind,
      }
  }

  try {
    const response = await fetch(url, { method, headers, body: JSON.stringify(body) })
    if (!response.ok) {
      return {
        issue: mutation.issue,
        kind: mutation.kind,
        request: mutation.request,
        status: 'failed',
        detail: 'HTTP ' + response.status + ' ' + (await response.text()).slice(0, 200),
      }
    }
    return {
      issue: mutation.issue,
      kind: mutation.kind,
      request: mutation.request,
      status: 'sent',
    }
  } catch (error) {
    return {
      issue: mutation.issue,
      kind: mutation.kind,
      request: mutation.request,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function POST(request: Request) {
  const { corpus, weights } = await load()

  let body: ApplyRequest
  try {
    body = (await request.json()) as ApplyRequest
  } catch {
    return NextResponse.json({ error: 'expected a JSON body with a caseId' }, { status: 400 })
  }
  if (!body?.caseId) {
    return NextResponse.json({ error: 'caseId is required' }, { status: 400 })
  }

  const model = body.model ?? emptyModel()
  const now = new Date(body.now ?? corpus.meta.builtAt)

  // Rebuild against the model as it was BEFORE the verdict settled this case,
  // otherwise the case has already been removed from the docket.
  const withoutThisCase: OperatorModel = {
    ...model,
    settled: model.settled.filter((id) => id !== body.caseId),
  }
  const { cases } = buildDocket({ corpus, weights, model: withoutThisCase, now })
  const kase = cases.find((c) => c.id === body.caseId)

  if (!kase) {
    return NextResponse.json({ error: 'no such case: ' + body.caseId }, { status: 404 })
  }

  const mutations =
    body.scope === 'auto' ? kase.action.autonomous : kase.action.mutations

  const token = (process.env.GITHUB_WRITE_TOKEN ?? '').trim()
  const target = (process.env.DOCKET_TARGET_REPO ?? '').trim()

  const live = token.length > 0 && target.length > 0 && target !== UPSTREAM
  const refusedUpstream = target === UPSTREAM

  const results: Executed[] = live
    ? await mutations.reduce<Promise<Executed[]>>(async (previous, mutation) => {
        // Sequential on purpose. Firing 230 writes concurrently is how an
        // integration gets secondary-rate-limited and half-applied.
        const done = await previous
        done.push(await send(mutation, target, token))
        return done
      }, Promise.resolve([]))
    : mutations.map((mutation) => ({
        issue: mutation.issue,
        kind: mutation.kind,
        request: mutation.request,
        status: 'dry-run' as const,
      }))

  return NextResponse.json({
    caseId: kase.id,
    summary: kase.action.summary,
    mode: live ? 'live' : 'dry-run',
    target: live ? target : null,
    reversal: kase.action.reversal,
    reversibility: kase.action.reversibility,
    requested: mutations.length,
    sent: results.filter((r) => r.status === 'sent').length,
    failed: results.filter((r) => r.status === 'failed').length,
    note: live
      ? 'Executed against ' + target + '.'
      : refusedUpstream
        ? 'Refused: DOCKET_TARGET_REPO is the upstream repository (' +
          UPSTREAM +
          '), whose issues belong to real people waiting on them. There is no override. ' +
          'Point it at a repository you own.'
        : 'Dry run. Set GITHUB_WRITE_TOKEN and DOCKET_TARGET_REPO to a repository you own ' +
          'to execute these same requests for real.',
    results: results.slice(0, 50),
  })
}
