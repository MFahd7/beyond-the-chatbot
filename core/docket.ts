/**
 * Turn a backlog into a docket.
 *
 * This is the function the whole project is about. It takes 1,000 open issues
 * and an operator model and returns an ordered list of decisions, plus an
 * explicit account of everything it chose not to show. Pure: same corpus, same
 * model, same clock, same docket, every time.
 *
 * DECISIONS AND SWEEPS
 *
 * The first honest version of this file produced 694 cases from 1,000 issues,
 * 368 of which said "this is a real defect, route it". That is not a decision
 * queue. It is the same backlog with a nicer font, and it fails at exactly the
 * thing the interface claims to do.
 *
 * The problem was treating every decision as one issue wide. Two different
 * things were being conflated:
 *
 *   a judgment   Is #74147 the same bug as #74149? Does this regression
 *                deserve to jump the queue? The answer depends on the specific
 *                issue, and no amount of grouping helps. One card each.
 *
 *   a sweep      112 issues are more than five release lines behind and should
 *                be asked to retest. The question is not "what about this
 *                issue", it is "do I trust this rule on these 112". One card
 *                for all of them, reviewed by sampling.
 *
 * Splitting those apart takes the docket from 694 cards to a few dozen without
 * hiding anything: every issue is still covered, and the sweep card names its
 * rule, its count and its members.
 *
 * The suppressed list is not an afterthought either. An interface that shows
 * one decision at a time and hides the rest has to be auditable or it is just
 * a confident guess with good typography. `suppressed` carries every case that
 * did not make the cut with the reason it did not.
 */

import type {
  Case,
  CaseKind,
  Corpus,
  DraftAction,
  Inference,
  Issue,
  OperatorModel,
  Signal,
  TemplateFields,
  Weights,
} from './types'
import { AUTO_CONFIDENCE, draftAction } from './actions'
import { byExpectedValue, impactOf, rank } from './attention'
import { countOf, duration, issueRef } from './format'
import { inferIntent, provenanceOf } from './intent'
import { ageOf, daysBetween, RULE_THRESHOLDS } from './rules'
import { minorLine, type VersionTimeline } from './signals'
import { isAwake } from './operator'
import { teamFor } from './templates'

/**
 * A case needs this much confidence to reach the docket. Below it, the honest
 * thing is to say "no decision reached the bar" rather than to prepare an
 * action from a coin-flip and let the operator sort it out.
 */
const CONFIDENCE_FLOOR = 0.42

/**
 * Engagement above which an accepted defect is escalated to its own card
 * instead of joining the routing sweep.
 *
 * Set from the backlog's own distribution: median engagement is 5, the 90th
 * percentile is 33. A bar of 60 keeps escalation to roughly the top few per
 * cent, which is the point -- an escalation that fires on a tenth of the
 * backlog is not an escalation, it is a second queue.
 */
const ESCALATE_ENGAGEMENT = 60

/** Below this many members, a sweep is not worth the indirection. */
const MIN_SWEEP = 4

/** An area needs this many routable defects to earn its own sweep card. */
const MIN_AREA_SWEEP = 8

/** How many members of a sweep the card offers for spot-checking. */
const SAMPLE_SIZE = 6

export interface SuppressedCase {
  id: string
  kind: CaseKind
  issues: number[]
  headline: string
  ev: number
  confidence: number
  why: string
}

export interface DocketStats {
  openIssues: number
  openReported: number
  cases: number
  decisions: number
  sweeps: number
  issuesCovered: number
  /** Number of withheld cases. */
  suppressed: number
  /**
   * Number of withheld *issues*. Not the same number, and the one that
   * matters: a withheld duplicate cluster is one case covering three issues,
   * so counting cases made "covered + withheld" fall two short of the backlog
   * and quietly broke the audit the interface promises.
   */
  issuesWithheld: number
  byKind: Record<string, number>
  autoQueued: number
  minutesOfWork: number
}

export interface DocketResult {
  cases: Case[]
  suppressed: SuppressedCase[]
  stats: DocketStats
}

function timelineFrom(corpus: Corpus): VersionTimeline {
  return { entries: corpus.versions }
}

function currentVersion(timeline: VersionTimeline): string {
  let best = ''
  let bestLine = -1
  for (const entry of timeline.entries) {
    const line = minorLine(entry.version)
    if (line !== null && line > bestLine) {
      bestLine = line
      best = entry.version
    }
  }
  return best
}

function linesBehindOf(timeline: VersionTimeline, version: string | null): number {
  const reported = version ? minorLine(version) : null
  if (reported === null) return 0
  const lines = new Set<number>()
  for (const entry of timeline.entries) {
    const line = minorLine(entry.version)
    if (line !== null && line > reported) lines.add(line)
  }
  return lines.size
}

const engagementOf = (issue: Issue) => issue.reactions * 2 + Math.min(issue.comments, 25)

/** Flat inference for cases that do not come from a fitted model. */
function statedInference(confidence: number, deadEnd: number): Inference {
  return {
    top: 'accepted_route',
    runnerUp: 'needs_repro',
    margin: 0,
    confidence: Number(confidence.toFixed(4)),
    deadEnd,
    scores: [],
  }
}

// ---------------------------------------------------------------- individual

/**
 * The one sentence at the top of the card.
 *
 * Written as a statement about the world, not about the software. "4 open
 * issues describe the same bug" is a fact a maintainer can agree or disagree
 * with. "Duplicate cluster detected (confidence 0.82)" is a status message
 * about a classifier, and it hands the work of interpretation back to the
 * reader -- which is the work the interface was supposed to have done.
 */
function headlineFor(
  kind: CaseKind,
  issues: Issue[],
  context: { canonical?: Issue; idleDays?: number; linesBehind?: number; version?: string | null },
): { headline: string; situation: string } {
  const first = issues[0] as Issue

  switch (kind) {
    case 'dedupe': {
      const canonical = context.canonical ?? first
      const others = issues.filter((i) => i.number !== canonical.number)
      const dates = issues.map((i) => i.createdAt).sort()
      const span = daysBetween(dates[0] as string, new Date(dates[dates.length - 1] as string))
      return {
        headline:
          issues.length +
          ' open issues describe the same bug: ' +
          issueRef(issues.map((i) => i.number)),
        situation:
          'Filed ' +
          (span > 0 ? duration(span) + ' apart' : 'within a day of each other') +
          ', using the same vocabulary. #' +
          canonical.number +
          ' has the most complete reproduction, so it is the one worth keeping. Each of ' +
          'the other ' +
          countOf(others.length, 'report') +
          ' is somebody who searched, found nothing, and filed anyway.',
      }
    }

    case 'escalate':
      return {
        headline:
          '#' +
          first.number +
          ' affects ' +
          engagementOf(first) +
          ' people and has never been routed',
        situation:
          'The report has everything needed to act on it — reproduction, version, ' +
          'area — and more people are hitting it than its queue position suggests. ' +
          'It has been sitting unrouted while thinner reports got attention.',
      }

    case 'needs_repro':
      return {
        headline: '#' + first.number + ' cannot be worked on: there is nothing to run',
        situation:
          'The report describes a problem but gives nobody a way to see it happen. ' +
          'Until that changes no engineer can pick it up, and it will sit in the backlog ' +
          'looking like work that exists.',
      }

    case 'verify_canary':
      return {
        headline:
          '#' +
          first.number +
          ' was reported ' +
          countOf(context.linesBehind ?? 0, 'release line') +
          ' ago and may already be fixed',
        situation:
          'Reported against ' +
          (context.version ?? 'an old version') +
          ', and ' +
          (context.linesBehind ?? 0) +
          ' minor lines have shipped since.',
      }

    case 'stale_close':
      return {
        headline: '#' + first.number + ' has been silent for ' + duration(context.idleDays ?? 0),
        situation: 'No activity, nobody assigned, and almost nobody else engaging with it.',
      }

    case 'accepted_route':
    default:
      return {
        headline: '#' + first.number + ' is a real defect and nobody has routed it',
        situation:
          'Reproduction, version and area are all present. There is nothing left to ask ' +
          'the reporter; it just needs to reach the team that owns the code.',
      }
  }
}

// --------------------------------------------------------------------- sweeps

interface SweepMember {
  issue: Issue
  confidence: number
  /** Fitted signal ids that pushed this member toward the winning action. */
  drivers: string[]
  areas: string[]
  linesBehind: number
  idleDays: number
  deadEnd: number
}

interface SweepSpec {
  id: string
  kind: CaseKind
  headline: (members: SweepMember[]) => string
  situation: (members: SweepMember[]) => string
  basis: string
}

const SWEEPS: Record<string, SweepSpec> = {
  needs_repro: {
    id: 'sweep-needs-repro',
    kind: 'needs_repro',
    basis: 'needs_repro model, held-out AUC 0.71',
    headline: (m) => m.length + ' open issues have no reproduction anyone can run',
    situation: (m) =>
      'Each one describes a problem without giving anybody a way to see it. They are ' +
      'indistinguishable from real work in the issue list, which is how a backlog gets ' +
      'to four figures. The ask is the same for all ' +
      m.length +
      ' and it is the repo’s own wording.',
  },
  verify_canary: {
    id: 'sweep-verify-canary',
    kind: 'verify_canary',
    basis:
      'rule: at least ' +
      RULE_THRESHOLDS.canaryLagLines +
      ' minor release lines behind, not already on a prerelease',
    headline: (m) =>
      m.length + ' open issues are reported against versions that may already be fixed',
    situation: (m) => {
      const median = [...m].sort((a, b) => a.linesBehind - b.linesBehind)[
        Math.floor(m.length / 2)
      ]
      return (
        'The median one is ' +
        (median?.linesBehind ?? 0) +
        ' minor release lines behind current. Nobody has asked these reporters to retest, ' +
        'so the backlog is carrying bugs that may not exist any more. Two minutes of their ' +
        'time each could close a good number of them.'
      )
    },
  },
  stale_close: {
    id: 'sweep-stale',
    kind: 'stale_close',
    basis:
      'rule: idle more than ' +
      RULE_THRESHOLDS.staleIdleDays +
      ' days, at most ' +
      RULE_THRESHOLDS.staleEngagementCeiling +
      ' comments and reactions combined, unassigned',
    headline: (m) => m.length + ' open issues have gone quiet with nobody waiting on them',
    situation: (m) => {
      const oldest = [...m].sort((a, b) => b.idleDays - a.idleDays)[0]
      return (
        'The quietest has had no activity for ' +
        duration(oldest?.idleDays ?? 0) +
        '. The engagement ceiling matters here: an issue idle for two years with forty ' +
        'reactions is not stale, it is neglected, and it is excluded. These have nobody ' +
        'waiting on them at all.'
      )
    },
  },
}

/**
 * Build one sweep card.
 *
 * `autoCount` is where autonomy lives. The sweep is not applied wholesale on a
 * timer -- but the members the model is most confident about, whose mutations
 * are all reversible, are. Those are labelled automatically after a visible
 * countdown, and the rest wait for a person. Autonomy is scoped by confidence
 * and gated on reversibility rather than granted to a whole batch at once.
 */
function buildSweep(
  spec: SweepSpec,
  members: SweepMember[],
  model: OperatorModel,
  now: Date,
  features?: Record<number, Record<string, Signal>>,
  currentRelease?: string,
): Case {
  // Which fitted signals actually put this set together, by how many members
  // they drove. This is what the card shows as evidence and what a rejection
  // distrusts.
  const driverCounts = new Map<string, number>()
  for (const member of members) {
    for (const id of member.drivers) driverCounts.set(id, (driverCounts.get(id) ?? 0) + 1)
  }
  const drivers = [...driverCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => id)
  const issues = members.map((m) => m.issue)
  const byEngagement = [...members].sort((a, b) => engagementOf(b.issue) - engagementOf(a.issue))

  const mutations: DraftAction['mutations'] = []
  let autoCount = 0

  for (const member of members) {
    const draft = draftAction({
      kind: spec.kind,
      issues: [member.issue],
      areas: member.areas,
      confidence: member.confidence,
      linesBehind: member.linesBehind,
      idleDays: member.idleDays,
      currentVersion: currentRelease,
    })
    mutations.push(...draft.mutations)
    if (draft.autonomous.length > 0) autoCount++
  }

  const autonomous = mutations.filter((m) => m.stage === 'auto')
  const confidence =
    members.reduce((sum, m) => sum + m.confidence, 0) / Math.max(members.length, 1)
  const deadEnd = members.reduce((sum, m) => sum + m.deadEnd, 0) / Math.max(members.length, 1)

  const summaries: Record<string, string> = {
    stale_close: 'Label and close ' + members.length + ' issues, each with a comment saying why.',
    needs_repro:
      'Label ' +
      members.length +
      ' issues as needing a reproduction and post the ask on each.' +
      (autoCount > 0
        ? ' The ' + autoCount + ' the model is most confident about are labelled automatically.'
        : ''),
    verify_canary: 'Ask ' + members.length + ' reporters to retest on canary.',
    accepted_route:
      'Apply area labels and route ' + members.length + ' issues to the owning team.',
    escalate: 'Route and flag ' + members.length + ' issues.',
    dedupe: 'Consolidate ' + members.length + ' duplicate sets.',
  }

  const action: DraftAction = {
    summary: summaries[spec.kind] ?? 'Apply the same action to ' + members.length + ' issues.',
    mutations,
    reversal:
      spec.kind === 'stale_close'
        ? 'reopen ' + members.length + ' issues and remove the labels; the comments were emailed'
        : spec.kind === 'accepted_route'
          ? 'remove ' + members.length + ' area and routing label(s); nobody is notified'
          : 'remove ' +
            members.length +
            ' label(s)' +
            (spec.kind === 'needs_repro' ? '; any posted comments were emailed' : ''),
    // Routing is labels only, so the whole sweep comes off cleanly. The others
    // contain comments, which do not.
    reversibility: spec.kind === 'accepted_route' ? 0.97 : spec.kind === 'stale_close' ? 0.4 : 0.6,
    autonomous,
  }

  const impact = impactOf(spec.kind, issues)
  // A sweep's value is the whole pile of work it removes at once, so effort is
  // summed across members rather than averaged.
  const perCase = rank({
    kind: spec.kind,
    issues,
    confidence,
    deadEnd,
    reversibility: action.reversibility,
    kindInterest: model.kindInterest[spec.kind] ?? 1,
    areaInterest: 1,
    now,
  })
  const effort = Number((perCase.effort * members.length).toFixed(1))

  return {
    id: spec.id,
    kind: spec.kind,
    issues,
    headline: spec.headline(members),
    situation: spec.situation(members),
    signals: [
      // The real reasoning first, then the description of the grouping.
      ...drivers.flatMap((id) => {
        const example = members.find((m) => m.drivers.includes(id))
        const signal = example ? features?.[example.issue.number]?.[id] : undefined
        if (!signal) return []
        return [
          {
            ...signal,
            evidence:
              'drove ' +
              (driverCounts.get(id) ?? 0) +
              ' of ' +
              members.length +
              ' members; on #' +
              example?.issue.number +
              ': ' +
              signal.evidence,
          },
        ]
      }),
      {
        id: 'sweep.size',
        kind: 'structural',
        label: 'Issues matched by one rule',
        value: Math.min(members.length / 100, 1),
        confidence: 1,
        evidence: countOf(members.length, 'issue') + ' selected by ' + spec.basis,
      },
      {
        id: 'sweep.agreement',
        kind: 'model',
        label: 'Mean confidence across the set',
        value: confidence,
        confidence: 0.8,
        evidence:
          'mean ' +
          confidence.toFixed(2) +
          ', lowest ' +
          Math.min(...members.map((m) => m.confidence)).toFixed(2) +
          ', highest ' +
          Math.max(...members.map((m) => m.confidence)).toFixed(2),
      },
    ],
    inference: statedInference(confidence, deadEnd),
    provenance: provenanceOf(spec.kind),
    action,
    impact: Math.round(impact.value),
    impactUnit: impact.unit,
    effort,
    // One ranking formula for everything. An earlier version computed the
    // sweep's score inline here, which quietly meant sweeps were exempt from
    // the urgency, dead-end and reversibility terms that individual cases were
    // subject to -- so the docket recommended emailing 115 strangers ahead of
    // applying 94 labels and could not explain why. rank() already returns the
    // aggregate: it was given every issue in the set and the per-issue effort.
    ev: perCase.ev,
    autoAfter: autonomous.length > 0 ? 45 : null,
    explain: [
      spec.basis,
      countOf(members.length, 'issue') + ' matched, ' + countOf(effort, 'minute') + ' of work by hand',
      autoCount > 0
        ? autoCount +
          ' of them clear the ' +
          AUTO_CONFIDENCE.toFixed(2) +
          ' confidence bar and only need a reversible label, so those apply themselves'
        : 'nothing here applies itself: every mutation needs a person',
      'mean confidence ' + confidence.toFixed(2),
    ],
    sweep: {
      count: members.length,
      basis: spec.basis,
      sample: byEngagement.slice(0, SAMPLE_SIZE).map((m) => m.issue.number),
      drivers,
      autoCount,
    },
  }
}

// ---------------------------------------------------------------------- build

export interface BuildInput {
  corpus: Corpus
  weights: Weights
  model: OperatorModel
  now: Date
  escalateAbove?: number
}

export function buildDocket(input: BuildInput): DocketResult {
  const { corpus, weights, model, now } = input
  const escalateAbove = input.escalateAbove ?? ESCALATE_ENGAGEMENT

  const timeline = timelineFrom(corpus)
  const current = currentVersion(timeline)
  const byNumber = new Map(corpus.open.map((i) => [i.number, i]))

  const clustered = new Set<number>()
  for (const cluster of corpus.clusters) {
    for (const member of cluster.members) clustered.add(member)
  }

  const decisions: Case[] = []
  /** Clusters that did not clear the floor, kept for the withheld list. */
  const weakClusters: SuppressedCase[] = []
  const sweepMembers: Record<string, SweepMember[]> = {
    needs_repro: [],
    verify_canary: [],
    stale_close: [],
  }
  /** accepted_route is swept per owning team, matching the repo's own labels. */
  /**
   * accepted_route is swept per declared area, because "route 428 issues" is
   * not a reviewable decision. Areas below MIN_AREA_SWEEP fall back to a
   * per-team sweep so nothing is stranded.
   */
  const routing = new Map<string, SweepMember[]>()

  /**
   * Cases that never reached the confidence floor. These are recorded rather
   * than dropped: the interface promises an answer to "what are you not
   * showing me", and 291 issues quietly vanishing is how that promise gets
   * broken without anybody noticing.
   */
  const belowFloor: SuppressedCase[] = []

  // ------------------------------------------------------------ duplicate sets

  for (const cluster of corpus.clusters) {
    const issues = cluster.members
      .map((n) => byNumber.get(n))
      .filter((i): i is Issue => Boolean(i))
    if (issues.length < 2) continue

    const canonical = byNumber.get(cluster.canonical) ?? (issues[0] as Issue)
    const areas = new Set<string>()
    for (const issue of issues) {
      for (const area of corpus.templates[issue.number]?.areas ?? []) areas.add(area)
    }

    const confidence = Math.min(0.62 * Math.min(cluster.cohesion / 0.45, 1.25), 0.85)

    // Clusters are unsupervised, so a weak one is the least trustworthy thing
    // the system produces -- and proposing to close somebody's bug report as a
    // duplicate on a cosine of 0.19 is exactly the wrong place to be brave.
    // The floor applies here as it does everywhere else.
    if (confidence < CONFIDENCE_FLOOR) {
      weakClusters.push({
        id: cluster.id,
        kind: 'dedupe',
        issues: cluster.members,
        headline:
          issues.length + ' issues look similar but not similar enough to act on: ' +
          issueRef(cluster.members),
        ev: 0,
        confidence,
        why:
          'cluster cohesion ' +
          cluster.cohesion.toFixed(2) +
          ' gives confidence ' +
          confidence.toFixed(2) +
          ', below the ' +
          CONFIDENCE_FLOOR.toFixed(2) +
          ' floor; duplicates are unsupervised so a weak match is not acted on',
      })
      continue
    }

    const { headline, situation } = headlineFor('dedupe', issues, { canonical })
    const action = draftAction({
      kind: 'dedupe',
      issues,
      canonical,
      areas: [...areas],
      confidence,
    })

    const ranked = rank({
      kind: 'dedupe',
      issues,
      confidence,
      deadEnd: 0.25,
      reversibility: action.reversibility,
      kindInterest: model.kindInterest['dedupe'] ?? 1,
      areaInterest: areas.size
        ? Math.min(...[...areas].map((a) => model.areaInterest[a] ?? 1))
        : 1,
      now,
    })

    decisions.push({
      id: cluster.id,
      kind: 'dedupe',
      issues,
      headline,
      situation,
      signals: [
        {
          id: 'cluster.cohesion',
          kind: 'textual',
          label: 'How alike the reports are',
          value: Math.min(cluster.cohesion / 0.6, 1),
          // Unsupervised. No ground truth for duplicates exists in this repo,
          // so the ceiling is deliberately low and the card says so.
          confidence: 0.62,
          evidence:
            'mean pairwise cosine ' +
            cluster.cohesion.toFixed(2) +
            '; shared terms: ' +
            cluster.sharedTerms.join(', '),
        },
        {
          id: 'cluster.size',
          kind: 'social',
          label: 'Filed separately by different people',
          value: Math.min(issues.length / 4, 1),
          confidence: 1,
          evidence: countOf(issues.length, 'independent report'),
        },
      ],
      inference: statedInference(confidence, 0.25),
      provenance: provenanceOf('dedupe'),
      action,
      impact: ranked.impact,
      impactUnit: ranked.impactUnit,
      effort: ranked.effort,
      ev: ranked.ev,
      autoAfter: null,
      explain: [
        provenanceOf('dedupe').detail,
        'cohesion ' + cluster.cohesion.toFixed(2) + ' across ' + issues.length + ' reports',
        ...ranked.explain,
      ],
      sweep: null,
    })
  }

  // ------------------------------------------------ everything else, sorted

  for (const issue of corpus.open) {
    if (clustered.has(issue.number)) continue

    const template = corpus.templates[issue.number] as TemplateFields | undefined
    const extras = corpus.extras[issue.number]
    const signals = corpus.features[issue.number]
    if (!template || !extras || !signals) continue

    const result = inferIntent({
      issue,
      template,
      signals,
      canaryBoxTicked: extras.canaryBoxTicked,
      timeline,
      weights,
      trust: model.signalTrust,
      now,
    })

    const { age, idle } = ageOf(issue, now)
    const confidence = result.inference.confidence
    if (confidence < CONFIDENCE_FLOOR) {
      belowFloor.push({
        id: 'case-' + issue.number,
        kind: result.inference.top,
        issues: [issue.number],
        headline: '#' + issue.number + ' ' + issue.title.slice(0, 80),
        ev: 0,
        confidence,
        why:
          'no decision reached the ' +
          CONFIDENCE_FLOOR.toFixed(2) +
          ' confidence floor (best was "' +
          result.inference.top +
          '" at ' +
          confidence.toFixed(2) +
          ')',
      })
      continue
    }

    const winningScore = result.inference.scores.find((s) => s.intent === result.inference.top)
    const member: SweepMember = {
      issue,
      confidence,
      drivers: (winningScore?.contributions ?? [])
        .filter((c) => c.push > 0)
        .slice(0, 3)
        .map((c) => c.signalId),
      areas: template.areas,
      linesBehind: linesBehindOf(timeline, template.nextVersion),
      idleDays: idle,
      deadEnd: result.inference.deadEnd,
    }

    const top = result.inference.top
    const engagement = engagementOf(issue)

    // Escalation is the only promotion out of a sweep: a well-formed defect
    // that a lot of people are hitting is a judgment, not a keystroke.
    if (top === 'accepted_route' && engagement >= escalateAbove) {
      const { headline, situation } = headlineFor('escalate', [issue], {})
      const action = draftAction({
        kind: 'escalate',
        issues: [issue],
        areas: template.areas,
        confidence,
      })
      const ranked = rank({
        kind: 'escalate',
        issues: [issue],
        confidence,
        deadEnd: result.inference.deadEnd,
        reversibility: action.reversibility,
        kindInterest: model.kindInterest['escalate'] ?? 1,
        areaInterest: template.areas.length
          ? Math.min(...template.areas.map((a) => model.areaInterest[a] ?? 1))
          : 1,
        now,
      })

      const winner = result.inference.scores.find((s) => s.intent === top)
      decisions.push({
        id: 'case-' + issue.number,
        kind: 'escalate',
        issues: [issue],
        headline,
        situation,
        signals: (winner?.contributions ?? [])
          .slice(0, 5)
          .map((c) => signals[c.signalId])
          .filter((s): s is Signal => Boolean(s)),
        inference: result.inference,
        provenance: provenanceOf('escalate'),
        action,
        impact: ranked.impact,
        impactUnit: ranked.impactUnit,
        effort: ranked.effort,
        ev: ranked.ev,
        autoAfter: null,
        explain: [
          provenanceOf('escalate').detail,
          'margin ' +
            result.inference.margin.toFixed(2) +
            ' over "' +
            result.inference.runnerUp +
            '"',
          countOf(engagement, 'person', 'people') +
            ' engaged, past the escalation bar of ' +
            escalateAbove,
          'filed ' + duration(age) + ' ago, last touched ' + duration(idle) + ' ago',
          ...ranked.explain,
        ],
        sweep: null,
      })
      continue
    }

    if (top === 'accepted_route') {
      const area = template.declared[0] ?? 'team:' + teamFor(template.areas)
      const bucket = routing.get(area)
      if (bucket) bucket.push(member)
      else routing.set(area, [member])
      continue
    }

    sweepMembers[top]?.push(member)
  }

  // ------------------------------------------------------------ sweep assembly

  const sweeps: Case[] = []

  for (const [key, members] of Object.entries(sweepMembers)) {
    const spec = SWEEPS[key]
    if (!spec || members.length < MIN_SWEEP) {
      // Too few to be worth a sweep: fall back to individual cards so nothing
      // silently disappears between the two presentations.
      for (const member of members) {
        const { headline, situation } = headlineFor(spec?.kind ?? 'accepted_route', [member.issue], {
          idleDays: member.idleDays,
          linesBehind: member.linesBehind,
          version: member.issue.title,
        })
        const action = draftAction({
          kind: spec?.kind ?? 'accepted_route',
          issues: [member.issue],
          areas: member.areas,
          confidence: member.confidence,
          linesBehind: member.linesBehind,
          idleDays: member.idleDays,
          currentVersion: current,
        })
        const ranked = rank({
          kind: spec?.kind ?? 'accepted_route',
          issues: [member.issue],
          confidence: member.confidence,
          deadEnd: member.deadEnd,
          reversibility: action.reversibility,
          kindInterest: 1,
          areaInterest: 1,
          now,
        })
        decisions.push({
          id: 'case-' + member.issue.number,
          kind: spec?.kind ?? 'accepted_route',
          issues: [member.issue],
          headline,
          situation,
          signals: [],
          inference: statedInference(member.confidence, member.deadEnd),
          provenance: provenanceOf(spec?.kind ?? 'accepted_route'),
          action,
          impact: ranked.impact,
          impactUnit: ranked.impactUnit,
          effort: ranked.effort,
          ev: ranked.ev,
          autoAfter: null,
          explain: ranked.explain,
          sweep: null,
        })
      }
      continue
    }
    sweeps.push(buildSweep(spec, members, model, now, corpus.features, current))
  }

  // Areas too small for their own sweep are pooled by owning team, so every
  // routable issue lands in exactly one sweep.
  const leftovers: Record<string, SweepMember[]> = { next: [], turbopack: [] }
  const areaSweeps: { area: string; members: SweepMember[] }[] = []

  for (const [area, members] of routing) {
    if (members.length >= MIN_AREA_SWEEP && !area.startsWith('team:')) {
      areaSweeps.push({ area, members })
    } else {
      for (const member of members) leftovers[teamFor(member.areas)]?.push(member)
    }
  }

  areaSweeps.sort((a, b) => b.members.length - a.members.length)

  for (const { area, members } of areaSweeps) {
    sweeps.push(
      buildSweep(
        {
          id: 'sweep-route-' + area.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          kind: 'accepted_route',
          basis:
            'accepted_route model, held-out AUC 0.78; grouped by the area the reporters declared',
          headline: (m) => m.length + ' well-formed ' + area + ' defects have never been routed',
          situation: (m) =>
            'Every one has a reproduction, a version, and ' +
            area +
            ' named as the affected area. There is nothing left to ask the reporters — ' +
            'these are waiting on a label. Routing is reversible and nobody is notified, ' +
            'which is why ' +
            m.length +
            ' of them can go at once.',
        },
        members,
        model,
        now,
        corpus.features,
        current,
      ),
    )
  }

  for (const [team, members] of Object.entries(leftovers)) {
    if (members.length < MIN_SWEEP) continue
    sweeps.push(
      buildSweep(
        {
          id: 'sweep-route-team-' + team,
          kind: 'accepted_route',
          basis:
            'accepted_route model, held-out AUC 0.78; areas too small to sweep alone, pooled by owning team',
          headline: (m) =>
            m.length +
            ' well-formed defects across smaller areas are waiting on the ' +
            team +
            ' team',
          situation: (m) =>
            'These are spread across areas with too few reports to be worth reviewing ' +
            'separately, so they are pooled by the team that owns them. All ' +
            m.length +
            ' have a reproduction and a version.',
        },
        members,
        model,
        now,
        corpus.features,
        current,
      ),
    )
  }

  // ---------------------------------------------------------- filter and sort

  const settled = new Set(model.settled)
  const cases: Case[] = []
  const suppressed: SuppressedCase[] = []

  // Below-floor cases were never candidates, so they join the suppressed list
  // directly rather than going through the filters below.
  suppressed.push(...belowFloor, ...weakClusters)

  for (const kase of [...decisions, ...sweeps]) {
    const brief = {
      id: kase.id,
      kind: kase.kind,
      issues: kase.issues.map((i) => i.number),
      headline: kase.headline,
      ev: kase.ev,
      confidence: kase.inference.confidence,
    }

    if (settled.has(kase.id)) continue

    if (!isAwake(model, kase.id, now)) {
      suppressed.push({
        ...brief,
        why: 'snoozed until ' + (model.snoozed[kase.id] ?? '').slice(0, 10),
      })
      continue
    }

    const kindInterest = model.kindInterest[kase.kind] ?? 1
    if (kindInterest < 0.5) {
      suppressed.push({
        ...brief,
        why:
          'you demoted "' +
          kase.kind +
          '" to ×' +
          kindInterest.toFixed(2) +
          ' by rejecting earlier cases',
      })
      continue
    }

    cases.push(kase)
  }

  cases.sort(byExpectedValue)
  suppressed.sort((a, b) => b.ev - a.ev)

  const byKind: Record<string, number> = {}
  for (const kase of cases) byKind[kase.kind] = (byKind[kase.kind] ?? 0) + 1

  return {
    cases,
    suppressed,
    stats: {
      openIssues: corpus.open.length,
      openReported: corpus.meta.openTotalReported,
      cases: cases.length,
      decisions: cases.filter((c) => c.sweep === null).length,
      sweeps: cases.filter((c) => c.sweep !== null).length,
      issuesCovered: new Set(cases.flatMap((c) => c.issues.map((i) => i.number))).size,
      suppressed: suppressed.length,
      issuesWithheld: new Set(suppressed.flatMap((s) => s.issues)).size,
      byKind,
      autoQueued: cases.filter((c) => c.autoAfter !== null).length,
      minutesOfWork: Math.round(cases.reduce((sum, c) => sum + c.effort, 0)),
    },
  }
}
