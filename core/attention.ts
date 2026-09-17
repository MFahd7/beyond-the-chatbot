/**
 * Decide what to put in front of the operator first.
 *
 * This is the part a dashboard cannot do and a chat window never gets asked
 * to. A dashboard sorts by a column, which means it sorts by whichever
 * property was easiest to store -- date, almost always -- and leaves the
 * ranking to whoever is scrolling. Chat has no queue at all: it answers the
 * question you thought to ask, so the issue you did not think to ask about
 * stays invisible no matter how much it matters.
 *
 * The ranking key is the expected value of the operator's attention:
 *
 *   ev = impact x confidence x urgency / effort
 *
 * Read it as: how many people this affects, times how likely we are to be
 * right about what to do, times how much worse it gets by waiting, divided by
 * how long it takes to deal with. Each term is computed from the corpus and
 * shown on the card, so a bad ordering can be argued with in the units that
 * produced it rather than dismissed as "the algorithm".
 *
 * Note which inputs appear here and nowhere else: engagement, age, duplicate
 * count. These accumulate after an issue is filed, which is exactly why
 * core/signals.ts refuses them as fitted features -- and exactly why they are
 * the right inputs for ranking, which makes no historical prediction at all.
 */

import type { Case, CaseKind, Issue } from './types'
import { daysBetween } from './rules'

/** Minutes of maintainer time each decision costs when done by hand. */
const EFFORT_MINUTES: Record<CaseKind, number> = {
  // Reading four reports, deciding which is canonical, writing a pointer
  // comment on each, closing three. This is the expensive one, which is why
  // it is worth automating first.
  dedupe: 11,
  escalate: 7,
  accepted_route: 4,
  needs_repro: 3,
  verify_canary: 2,
  stale_close: 1.5,
}

/**
 * How much worse this gets by sitting.
 *
 * Duplicates decay upward: every week an unmerged duplicate set stays open,
 * another person files into it and another maintainer reads it twice. A stale
 * close does not decay at all -- an issue quiet for nine months will be just
 * as closable next week, which is precisely why it should never outrank
 * anything.
 */
function urgency(kind: CaseKind, issues: Issue[], now: Date): { value: number; why: string } {
  const newest = issues.reduce(
    (latest, issue) => (issue.createdAt > latest ? issue.createdAt : latest),
    issues[0]?.createdAt ?? now.toISOString(),
  )
  const sinceNewest = daysBetween(newest, now)

  if (kind === 'dedupe') {
    // A cluster still being filed into is live; one whose last report was two
    // years ago is archaeology.
    const live = Math.max(0.35, 1.6 - sinceNewest / 240)
    return {
      value: Math.min(live, 1.6),
      why:
        sinceNewest < 60
          ? 'still being filed into: newest report ' + sinceNewest + ' days ago'
          : 'last new report ' + sinceNewest + ' days ago',
    }
  }

  if (kind === 'escalate') {
    return { value: 1.5, why: 'a regression with reach gets worse every release it survives' }
  }

  if (kind === 'stale_close') {
    return { value: 0.25, why: 'closable now, equally closable next month' }
  }

  if (kind === 'needs_repro') {
    // Asking for a reproduction works while the reporter still remembers the
    // bug. After a few months the ask is theatre.
    const fresh = Math.max(0.3, 1.2 - sinceNewest / 120)
    return {
      value: fresh,
      why:
        sinceNewest < 30
          ? 'reporter is still around: filed ' + sinceNewest + ' days ago'
          : 'filed ' + sinceNewest + ' days ago, so the reporter may be gone',
    }
  }

  return { value: 0.8, why: 'no particular time pressure' }
}

/**
 * People affected. Reactions weigh more than comments because a reaction is a
 * silent "me too" from someone with nothing to add, which is the closest thing
 * an issue tracker has to a headcount.
 */
export function impactOf(kind: CaseKind, issues: Issue[]): { value: number; unit: string } {
  // Comments are capped per issue. A thread with 300 comments is not 300
  // people affected -- it is usually four people disagreeing at length, plus a
  // maintainer. Reactions are the better headcount: a reaction is one person
  // with nothing to add saying "this is happening to me too", which is exactly
  // the quantity wanted here. Without the cap, a single long argument outranks
  // a genuine regression with sixty silent thumbs-up.
  const engagement = issues.reduce(
    (sum, issue) => sum + issue.reactions * 2 + Math.min(issue.comments, 25),
    0,
  )

  if (kind === 'dedupe') {
    // Each separate report is a person who searched, found nothing, and filed
    // anyway -- so the duplicate count is itself a measure of reach.
    return { value: engagement + issues.length * 6, unit: 'people affected' }
  }
  return { value: Math.max(engagement, 1), unit: 'people affected' }
}

export interface RankInput {
  kind: CaseKind
  issues: Issue[]
  confidence: number
  /**
   * How cleanly this action comes undone, from core/actions.ts.
   *
   * Ranking has to care about this, and the first version did not. The docket
   * put "ask 115 reporters to retest" at the top of the queue purely on reach,
   * without noticing that approving it sends mail to 115 strangers and cannot
   * be taken back. Applying 115 labels has comparable reach and costs nothing
   * if it turns out to be wrong. Attention should go to the second one first.
   */
  reversibility: number
  /** P(closed without a fix), from the resolution model. Discounts the score. */
  deadEnd: number
  /** Operator multipliers for this kind and its areas. */
  kindInterest: number
  areaInterest: number
  now: Date
}

export interface Ranked {
  ev: number
  impact: number
  impactUnit: string
  effort: number
  explain: string[]
}

export function rank(input: RankInput): Ranked {
  const { kind, issues, confidence, deadEnd, kindInterest, areaInterest, now } = input

  const impact = impactOf(kind, issues)
  const effort = EFFORT_MINUTES[kind]
  const time = urgency(kind, issues, now)

  // A fully reversible action keeps its whole score; an irreversible one is
  // worth roughly half as much attention at the same reach, because the
  // operator has to spend real scrutiny on it rather than a keystroke.
  const safety = 0.45 + 0.55 * input.reversibility

  // An issue the resolution model expects to be closed without a fix is worth
  // less attention, but the discount is bounded: the model is AUC 0.64, and a
  // 0.64 model should not be allowed to bury anything outright.
  const worthDoing = 1 - 0.35 * deadEnd

  const ev =
    (impact.value * confidence * time.value * worthDoing * safety * kindInterest * areaInterest) /
    effort

  return {
    ev: Number(ev.toFixed(3)),
    impact: Math.round(impact.value),
    impactUnit: impact.unit,
    effort,
    explain: [
      Math.round(impact.value) + ' ' + impact.unit + ' across ' + issues.length + ' report(s)',
      'confidence ' + (confidence * 100).toFixed(0) + '%',
      'urgency x' + time.value.toFixed(2) + ' -- ' + time.why,
      'costs about ' + effort + ' min by hand',
      input.reversibility >= 0.95
        ? 'fully reversible, so it needs a keystroke rather than scrutiny'
        : 'reversibility ' +
          input.reversibility.toFixed(2) +
          ', which discounts it to ×' +
          safety.toFixed(2) +
          ' of the attention its reach would otherwise earn',
      deadEnd > 0.55
        ? 'discounted: resolution model puts ' +
          (deadEnd * 100).toFixed(0) +
          '% on this being closed without a fix'
        : 'resolution model puts ' +
          ((1 - deadEnd) * 100).toFixed(0) +
          '% on this being genuinely actionable',
    ],
  }
}

/** Sort cases by expected value, highest first. Ties break on fewer issues. */
export function byExpectedValue(a: Case, b: Case): number {
  if (b.ev !== a.ev) return b.ev - a.ev
  return a.issues.length - b.issues.length
}
