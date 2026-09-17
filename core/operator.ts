/**
 * What the docket learns when it gets something wrong.
 *
 * This is the part the challenge brief calls the failure test, and it is the
 * reason the interface can afford to guess at all. A system that surfaces one
 * decision at a time is making a much stronger claim than a dashboard: it is
 * saying *this* is the thing to look at, and hiding everything else. That is
 * only acceptable if being wrong is cheap, visible and corrective.
 *
 * So rejection is not a dismissal. It is the highest-bandwidth input in the
 * interface, and it carries a reason:
 *
 *   wrong_situation   You read the issue wrong. -> distrust the signals that
 *                     drove this particular reading, everywhere they appear.
 *   wrong_action      Right reading, wrong response. -> keep the signals,
 *                     demote this kind of decision.
 *   wrong_priority    Right decision, wrong moment. -> demote the kind in the
 *                     ranking, but keep it visible.
 *   not_my_area       Not my code. -> demote the area, not the reasoning.
 *   stale_evidence    You are reasoning from facts that have expired. ->
 *                     distrust the time-based signals.
 *
 * Each reason edits a different part of the model, which is the whole point:
 * "wrong" is not one piece of information, and a thumbs-down button throws
 * away the part that would have been useful.
 *
 * Every edit is recorded with its before and after value, so the interface can
 * show what it just changed instead of silently becoming a different system.
 * An operator who cannot see what their correction did has no reason to make
 * another one.
 */

import type { Case, CaseKind, FeedbackEvent, OperatorModel, RejectReason, Verdict } from './types'

/**
 * The minimum a correction needs to know about what it is correcting.
 *
 * Deliberately narrow. An earlier version took a whole `Case`, which meant the
 * browser had to fabricate one -- complete with invented timestamps and a
 * guessed `inference.top` -- out of the trimmed payload it actually had, just
 * to call this function. That is the kind of shim that works until someone
 * changes a field name. These five fields are everything feedback uses, so
 * they are what it asks for.
 */
export interface FeedbackTarget {
  id: string
  kind: CaseKind
  /** Signal ids that drove the decision, strongest first. */
  drivers: string[]
  /** Signal ids whose evidence was time-based. */
  temporal: string[]
  /** Area labels carried by the issues in this case. */
  areas: string[]
}

/** Derive a target from a full Case. Used by the server and the tests. */
export function targetOf(kase: Case): FeedbackTarget {
  const top = kase.inference.scores.find((s) => s.intent === kase.inference.top)
  const fromModel = (top?.contributions ?? [])
    .filter((c) => c.push > 0)
    .slice(0, 3)
    .map((c) => c.signalId)

  const areas = new Set<string>()
  for (const issue of kase.issues) {
    for (const label of issue.labels) areas.add(label)
  }

  return {
    id: kase.id,
    kind: kase.kind,
    // Rule-driven cases have no contributions worth distrusting, so fall back
    // to the rule signals the card actually displayed.
    // A sweep's real drivers are the fitted signals that selected its members;
    // its own sweep.* rows describe the grouping, not the reasoning.
    drivers:
      kase.sweep && kase.sweep.drivers.length > 0
        ? kase.sweep.drivers
        : fromModel.length > 0
          ? fromModel
          : kase.signals.slice(0, 3).map((s) => s.id),
    temporal: kase.signals.filter((s) => s.kind === 'temporal').map((s) => s.id),
    areas: [...areas],
  }
}

/** Multipliers stay in this band. Beyond it, one bad afternoon erases a model. */
const FLOOR = 0.1
const CEILING = 2

/** How far a single rejection moves things. Deliberately blunt and visible. */
const DISTRUST_SIGNAL = 0.55
const DEMOTE_KIND = 0.45
const DEMOTE_AREA = 0.2
/** Approval nudges rather than shoves: agreement is weaker evidence than a veto. */
const REINFORCE = 1.06

const SNOOZE_DAYS = 7

export function emptyModel(): OperatorModel {
  return {
    signalTrust: {},
    areaInterest: {},
    kindInterest: {},
    snoozed: {},
    settled: [],
    history: [],
  }
}

function clamp(value: number): number {
  return Math.min(CEILING, Math.max(FLOOR, value))
}

interface Adjustment {
  target: string
  from: number
  to: number
  note: string
}

function move(
  bag: Record<string, number>,
  key: string,
  factor: number,
  note: string,
  adjustments: Adjustment[],
): void {
  const from = bag[key] ?? 1
  const to = clamp(from * factor)
  if (Math.abs(to - from) < 0.001) return
  bag[key] = to
  adjustments.push({ target: key, from: Number(from.toFixed(3)), to: Number(to.toFixed(3)), note })
}

export interface FeedbackInput {
  model: OperatorModel
  target: FeedbackTarget
  verdict: Verdict
  reason?: RejectReason | null
  now: Date
}

export interface FeedbackResult {
  model: OperatorModel
  event: FeedbackEvent
  /** Plain sentences describing what changed. Rendered verbatim. */
  summary: string[]
}

export function applyFeedback(input: FeedbackInput): FeedbackResult {
  const { target, verdict, now } = input
  const reason = input.reason ?? null

  // Copy rather than mutate: the caller holds the previous model and the
  // interface diffs the two to show what moved.
  const model: OperatorModel = {
    signalTrust: { ...input.model.signalTrust },
    areaInterest: { ...input.model.areaInterest },
    kindInterest: { ...input.model.kindInterest },
    snoozed: { ...input.model.snoozed },
    settled: [...input.model.settled],
    history: [...input.model.history],
  }

  const adjustments: Adjustment[] = []
  const summary: string[] = []

  const areas = new Set(target.areas)

  if (verdict === 'approve' || verdict === 'edit') {
    model.settled.push(target.id)
    for (const signalId of target.drivers) {
      move(model.signalTrust, signalId, REINFORCE, 'held up under review', adjustments)
    }
    move(model.kindInterest, target.kind, REINFORCE, 'this kind is landing', adjustments)
    summary.push(
      verdict === 'edit'
        ? 'Edited and applied. The reading was right, so the signals behind it gained a little trust.'
        : 'Applied. The signals behind it gained a little trust.',
    )
  }

  if (verdict === 'snooze') {
    const returns = new Date(now.getTime() + SNOOZE_DAYS * 86_400_000)
    model.snoozed[target.id] = returns.toISOString()
    summary.push('Back in ' + SNOOZE_DAYS + ' days. Nothing about the model changed.')
  }

  if (verdict === 'reject') {
    model.settled.push(target.id)

    switch (reason) {
      case 'wrong_situation': {
        const drove = target.drivers
        for (const signalId of drove) {
          move(
            model.signalTrust,
            signalId,
            DISTRUST_SIGNAL,
            'misread the situation on ' + target.id,
            adjustments,
          )
        }
        summary.push(
          'Distrusted the ' +
            drove.length +
            ' signal(s) that drove this reading. They now carry less weight in every ' +
            'decision type, not just this one.',
        )
        break
      }

      case 'wrong_action': {
        move(model.kindInterest, target.kind, DEMOTE_KIND, 'right reading, wrong action', adjustments)
        summary.push(
          'Kept the reading, demoted the response. "' +
            target.kind +
            '" will need a stronger case to reach the top of the docket.',
        )
        break
      }

      case 'wrong_priority': {
        move(
          model.kindInterest,
          target.kind,
          DEMOTE_KIND + 0.25,
          'correct but not now',
          adjustments,
        )
        summary.push(
          'Right decision, wrong moment. This kind drops down the order but stays in the docket.',
        )
        break
      }

      case 'not_my_area': {
        for (const area of areas) {
          move(model.areaInterest, area, DEMOTE_AREA, 'not this operator’s area', adjustments)
        }
        summary.push(
          areas.size > 0
            ? 'Demoted ' + [...areas].slice(0, 4).join(', ') + '. The reasoning was left alone.'
            : 'No area labels on this issue, so there was nothing specific to demote.',
        )
        break
      }

      case 'stale_evidence': {
        for (const signalId of target.temporal) {
          move(model.signalTrust, signalId, DISTRUST_SIGNAL, 'evidence had expired', adjustments)
        }
        summary.push('Distrusted the time-based evidence on this reading.')
        break
      }

      default: {
        move(model.kindInterest, target.kind, DEMOTE_KIND + 0.3, 'rejected, no reason given', adjustments)
        summary.push('Rejected without a reason, so only this kind was demoted slightly.')
      }
    }
  }

  const event: FeedbackEvent = {
    caseId: target.id,
    kind: target.kind,
    verdict,
    reason,
    at: now.toISOString(),
    adjustments,
  }
  model.history = [event, ...model.history].slice(0, 50)

  return { model, event, summary }
}

/** Whether a snoozed case has come back. */
export function isAwake(model: OperatorModel, caseId: string, now: Date): boolean {
  const until = model.snoozed[caseId]
  if (!until) return true
  return new Date(until) <= now
}

export function trustFor(model: OperatorModel, signalId: string): number {
  return model.signalTrust[signalId] ?? 1
}

/** The multipliers that are no longer 1, for the model-state panel. */
export function deviations(model: OperatorModel): {
  signals: { id: string; value: number }[]
  kinds: { id: string; value: number }[]
  areas: { id: string; value: number }[]
} {
  const pick = (bag: Record<string, number>) =>
    Object.entries(bag)
      .filter(([, value]) => Math.abs(value - 1) > 0.01)
      .map(([id, value]) => ({ id, value: Number(value.toFixed(3)) }))
      .sort((a, b) => Math.abs(b.value - 1) - Math.abs(a.value - 1))

  return {
    signals: pick(model.signalTrust),
    kinds: pick(model.kindInterest),
    areas: pick(model.areaInterest),
  }
}
