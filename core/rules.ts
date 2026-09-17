/**
 * The decisions that are rules, not predictions.
 *
 * Two of the four triage actions were fitted and cut (see SHIPPED_MODELS in
 * core/types.ts): staleness scored AUC 0.59, canary verification 0.49. Both
 * failed for the same reason, and it is a reason worth being precise about.
 *
 * The fitted feature set describes the submission only, because a feature that
 * accumulates after filing would let the model read the outcome off the back
 * of the card. But whether an issue has gone quiet, and whether the release
 * line has moved past it, are *exactly* facts about what happened after
 * filing. They were never in the features, so the models never had a chance.
 *
 * On an open issue those facts are not leakage at all -- they are the easiest
 * things in the world to observe. So they are rules here, with thresholds read
 * off the backlog's own distribution and printed in the interface next to the
 * decision. A maintainer can disagree with "quiet for nine months" in a way
 * they cannot disagree with a coefficient.
 *
 * Every threshold below was chosen by measuring the 1,000 open issues:
 *
 *   median age            435 days
 *   median time idle      183 days
 *   zero comments         190 issues
 *   zero engagement       129 issues
 *   assigned to anyone     70 issues
 */

import type { Issue, Signal, TemplateFields } from './types'
import { minorLine, type VersionTimeline } from './signals'

/** Idle longer than this and nobody is coming back to it on their own. */
const STALE_IDLE_DAYS = 270
/** Above this much engagement, other people are still waiting on it. */
const STALE_ENGAGEMENT_CEILING = 2
/** Behind by this many minor lines and "try canary" is the honest first ask. */
const CANARY_LAG_LINES = 5

export const RULE_THRESHOLDS = {
  staleIdleDays: STALE_IDLE_DAYS,
  staleEngagementCeiling: STALE_ENGAGEMENT_CEILING,
  canaryLagLines: CANARY_LAG_LINES,
}

export function daysBetween(from: string, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / 86_400_000))
}

export interface RuleHit {
  fires: boolean
  /** 0..1. How firmly the rule's conditions are met, not a probability. */
  strength: number
  signals: Signal[]
  because: string
}

/**
 * Has this gone quiet for long enough, with few enough people waiting, that
 * closing it loses nothing?
 *
 * The engagement ceiling is the important half. An issue idle for two years
 * with forty reactions is not stale, it is neglected, and closing it is how a
 * project earns a reputation for closing things people care about.
 */
export function staleRule(issue: Issue, now: Date): RuleHit {
  const idle = daysBetween(issue.updatedAt, now)
  const age = daysBetween(issue.createdAt, now)
  const engagement = issue.comments + issue.reactions

  const quiet = idle > STALE_IDLE_DAYS
  const ignored = engagement <= STALE_ENGAGEMENT_CEILING
  const unowned = issue.assignees.length === 0 && !issue.milestone

  const signals: Signal[] = [
    {
      id: 'rule.idle',
      kind: 'temporal',
      label: 'Nothing has happened for a long time',
      value: Math.min(idle / 730, 1),
      confidence: 1,
      evidence: 'last activity ' + idle + ' days ago; filed ' + age + ' days ago',
    },
    {
      id: 'rule.unwatched',
      kind: 'social',
      label: 'Nobody else is waiting on it',
      value: engagement === 0 ? 1 : Math.max(0, 1 - engagement / 6),
      confidence: 1,
      evidence: issue.comments + ' comment(s), ' + issue.reactions + ' reaction(s)',
    },
    {
      id: 'rule.unowned',
      kind: 'social',
      label: 'Not assigned to anyone',
      value: unowned ? 1 : 0,
      confidence: 1,
      evidence: unowned
        ? 'no assignee, no milestone'
        : 'assigned to ' + (issue.assignees.join(', ') || 'a milestone'),
    },
  ]

  const fires = quiet && ignored && unowned
  // Strength grows with how far past the bar it is, so a four-year-old silent
  // issue is not presented with the same confidence as one just over the line.
  const strength = fires ? Math.min(1, 0.55 + (idle - STALE_IDLE_DAYS) / 1000) : 0

  return {
    fires,
    strength,
    signals,
    because: fires
      ? 'Quiet for ' +
        idle +
        ' days with ' +
        engagement +
        ' total comment(s) and reaction(s), and nobody owns it.'
      : !quiet
        ? 'Still active ' + idle + ' days ago.'
        : !ignored
          ? engagement + ' people are still engaged with it.'
          : 'Somebody owns it.',
  }
}

/**
 * Is this reported against a version so far behind that the first honest reply
 * is "please try the current release"?
 *
 * Deliberately does not fire when the reporter is already on a prerelease, or
 * when they have ticked the canary box -- asking someone to do the thing they
 * just said they did is the fastest way to lose a reporter.
 */
export function canaryRule(
  issue: Issue,
  template: TemplateFields,
  timeline: VersionTimeline,
  canaryBoxTicked: boolean,
  now: Date,
): RuleHit {
  const reported = template.nextVersion ? minorLine(template.nextVersion) : null

  let frontier: number | null = null
  let frontierVersion = ''
  for (const entry of timeline.entries) {
    const line = minorLine(entry.version)
    if (line !== null && (frontier === null || line > frontier)) {
      frontier = line
      frontierVersion = entry.version
    }
  }

  const lines = new Set<number>()
  if (reported !== null) {
    for (const entry of timeline.entries) {
      const line = minorLine(entry.version)
      if (line !== null && line > reported) lines.add(line)
    }
  }
  const behind = lines.size

  const signals: Signal[] = [
    {
      id: 'rule.lines_behind',
      kind: 'temporal',
      label: 'Release lines shipped since the reported version',
      value: Math.min(behind / 20, 1),
      confidence: reported === null ? 0.2 : 0.95,
      evidence:
        reported === null
          ? 'no version reported'
          : behind +
            ' minor line(s) between ' +
            template.nextVersion +
            ' and the current ' +
            frontierVersion,
    },
    {
      id: 'rule.on_prerelease',
      kind: 'structural',
      label: 'Already testing a prerelease',
      value: template.onCanary ? 1 : 0,
      confidence: 0.92,
      evidence: template.onCanary
        ? template.nextVersion + ' is a prerelease'
        : 'on a stable release',
    },
  ]

  const fires =
    reported !== null && behind >= CANARY_LAG_LINES && !template.onCanary && !canaryBoxTicked

  return {
    fires,
    strength: fires ? Math.min(1, 0.5 + behind / 30) : 0,
    signals,
    because: fires
      ? behind +
        ' minor lines have shipped since ' +
        template.nextVersion +
        '. It may already be fixed.'
      : template.onCanary
        ? 'Already on a prerelease.'
        : canaryBoxTicked
          ? 'Reporter says they already checked canary.'
          : reported === null
            ? 'No version reported, so there is nothing to compare.'
            : 'Only ' + behind + ' line(s) behind; not far enough to be worth the ask.',
  }
}

/** Age in days, for the interface. Kept here so the unit is defined once. */
export function ageOf(issue: Issue, now: Date): { age: number; idle: number } {
  return { age: daysBetween(issue.createdAt, now), idle: daysBetween(issue.updatedAt, now) }
}
