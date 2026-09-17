/**
 * Turn one issue into a set of observations.
 *
 * THE RULE THAT KEEPS THIS HONEST
 *
 * Every signal in this file is a property of the *submission* -- what the
 * reporter typed, in the state they left it. Nothing here reads a field that
 * accumulates after the issue was filed.
 *
 * That rules out, deliberately: labels (the triage labels ARE the training
 * target), comment count (a `needs_repro` issue has a comment precisely
 * because a maintainer asked for a reproduction), reaction count, assignees,
 * milestone, close reason, and age. Every one of them is a post-treatment
 * variable, and feeding any of them to the classifier would let it read the
 * answer off the back of the card.
 *
 * Age is the tempting one, because "this is eight months old" is obviously
 * relevant to whether an issue is going nowhere. It is excluded anyway: for a
 * closed issue the elapsed time is final, for an open one it is a lower bound
 * that grows while you look at it, and fitting across the two teaches the
 * model about censoring rather than about bug reports.
 *
 * Age, comments, reactions and duplicate counts are used -- in
 * `core/attention.ts`, which ranks cases and is not fitted against anything.
 * Prediction and prioritisation are different jobs and they get different
 * inputs. This split is the main reason the held-out numbers in data/eval.json
 * are worth reading.
 */

import type { Issue, Signal, TemplateFields } from './types'
import type { TemplateExtras } from './templates'
import { prose, snippet } from './text'

/**
 * A release line derived from the corpus rather than from a changelog: the
 * first date each reported version shows up is a good proxy for when that
 * version was current. Lets "how far behind was this reporter" be computed
 * without hardcoding a release history that would go stale.
 */
export interface VersionTimeline {
  entries: { version: string; order: number; firstSeen: string; reports: number }[]
}

export function buildVersionTimeline(
  issues: { createdAt: string; template: TemplateFields }[],
): VersionTimeline {
  const seen = new Map<string, { order: number; firstSeen: string; reports: number }>()
  for (const { createdAt, template } of issues) {
    const version = template.nextVersion
    const order = template.nextVersionOrder
    if (!version || order === null) continue
    const existing = seen.get(version)
    if (!existing) {
      seen.set(version, { order, firstSeen: createdAt, reports: 1 })
    } else {
      existing.reports++
      if (createdAt < existing.firstSeen) existing.firstSeen = createdAt
    }
  }
  const entries = [...seen.entries()]
    // A version reported only once or twice is usually a typo, not a release.
    .filter(([, v]) => v.reports >= 3)
    .map(([version, v]) => ({ version, ...v }))
    .sort((a, b) => a.order - b.order)
  return { entries }
}

/**
 * The minor release line a version belongs to: 15.4.2 and 15.4.0-canary.7 are
 * both line 15.4. Lines are the unit that means something to a reporter --
 * "you are four minor lines behind" -- and, unlike a raw difference of version
 * orders, the unit does not change size when the major does.
 */
export function minorLine(version: string): number | null {
  const match = version.match(/^(\d+)\.(\d+)/)
  if (!match) return null
  return Number(match[1]) * 1000 + Number(match[2])
}

/** The newest release line that existed when this issue was filed. */
function frontierLineAt(timeline: VersionTimeline, when: string): number | null {
  let frontier: number | null = null
  for (const entry of timeline.entries) {
    if (entry.firstSeen > when) continue
    const line = minorLine(entry.version)
    if (line !== null && (frontier === null || line > frontier)) frontier = line
  }
  return frontier
}

/**
 * How many distinct minor lines shipped between the reported version and the
 * line current at filing. Counting real lines rather than subtracting version
 * numbers is what keeps this honest across a major bump.
 */
function linesBehind(timeline: VersionTimeline, reported: number, when: string): number {
  const lines = new Set<number>()
  for (const entry of timeline.entries) {
    if (entry.firstSeen > when) continue
    const line = minorLine(entry.version)
    if (line !== null && line > reported) lines.add(line)
  }
  return lines.size
}

/** Human-readable line, e.g. "15.4". */
function lineLabel(line: number): string {
  return Math.floor(line / 1000) + '.' + (line % 1000)
}

const VAGUE_TITLE =
  /^(bug|error|help|issue|problem|question|not working|doesn'?t work|broken|crash|fail(s|ed|ure)?)\W*$/i

function clamp(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function signal(
  id: string,
  kind: Signal['kind'],
  label: string,
  value: number,
  confidence: number,
  evidence: string,
): Signal {
  return { id, kind, label, value: clamp(value), confidence: clamp(confidence), evidence }
}

/**
 * The fitted feature set. Order is irrelevant; ids are the contract between
 * this file, data/weights.json and the evidence panel in the interface.
 */
export function extractSignals(
  issue: Issue,
  template: TemplateFields,
  extras: TemplateExtras,
  timeline: VersionTimeline,
): Record<string, Signal> {
  const out: Record<string, Signal> = {}
  const add = (s: Signal) => {
    out[s.id] = s
  }

  // ---------------------------------------------------------------- reproduction

  const hasRepro = Boolean(template.reproUrl) && !extras.reproIsPlaceholder
  add(
    signal(
      'repro.present',
      'structural',
      hasRepro ? 'Has a reproduction' : 'No usable reproduction',
      hasRepro ? 1 : 0,
      0.97,
      hasRepro ? (template.reproUrl as string) : 'reproduction field holds no usable link',
    ),
  )

  add(
    signal(
      'repro.field_blank',
      'structural',
      'Reproduction field was asked for and left empty',
      extras.reproFieldPresent && !template.reproUrl ? 1 : 0,
      0.95,
      extras.reproFieldPresent
        ? template.reproUrl
          ? 'field filled in'
          : 'field present, answered "_No response_"'
        : 'template never asked',
    ),
  )

  // Present only to absorb template generation, so it cannot masquerade as
  // reporter effort. See the header comment in core/templates.ts.
  add(
    signal(
      'repro.field_absent',
      'structural',
      'This template generation never asked for a reproduction',
      extras.reproFieldPresent ? 0 : 1,
      0.99,
      'template generation: ' + extras.generation,
    ),
  )

  add(
    signal(
      'repro.github',
      'structural',
      'Reproduction is a git repository',
      template.reproKind === 'github' ? 1 : 0,
      0.9,
      template.reproKind === 'github' ? (template.reproUrl as string) : 'not a repository link',
    ),
  )

  add(
    signal(
      'repro.sandbox',
      'structural',
      'Reproduction is a hosted sandbox',
      template.reproKind === 'sandbox' ? 1 : 0,
      0.9,
      template.reproKind === 'sandbox' ? (template.reproUrl as string) : 'not a sandbox link',
    ),
  )

  add(
    signal(
      'repro.placeholder',
      'structural',
      "Reproduction link is the template's own example",
      extras.reproIsPlaceholder ? 1 : 0,
      0.99,
      extras.reproIsPlaceholder
        ? 'pasted back unchanged: ' + template.reproUrl
        : 'not the template placeholder',
    ),
  )

  // ---------------------------------------------------------------- template use

  add(
    signal(
      'template.none',
      'structural',
      'Filed without the template',
      extras.generation === 'none' ? 1 : 0,
      0.93,
      'template generation: ' + extras.generation,
    ),
  )

  add(
    signal(
      'template.blank_sections',
      'structural',
      'Template sections left blank',
      Math.min(extras.blankSections, 4) / 4,
      0.95,
      extras.blankSections + ' section(s) answered "_No response_"',
    ),
  )

  // ---------------------------------------------------------------- environment

  add(
    signal(
      'env.version_present',
      'structural',
      'Reported which version they are on',
      template.nextVersion ? 1 : 0,
      0.95,
      template.nextVersion ? 'next: ' + template.nextVersion : 'no version anywhere in the report',
    ),
  )

  add(
    signal(
      'env.node_present',
      'structural',
      'Reported a Node version',
      template.nodeVersion ? 1 : 0,
      0.95,
      template.nodeVersion ? 'Node: ' + template.nodeVersion : 'no Node version reported',
    ),
  )

  // Era-invariant by construction: distance from the release frontier as it
  // stood on the day of filing, not distance from today. An issue filed in
  // 2022 against the then-current version counts as zero lag, exactly like one
  // filed last week against the version current last week.
  const reportedLine = template.nextVersion ? minorLine(template.nextVersion) : null
  const frontierLine = frontierLineAt(timeline, issue.createdAt)
  let lagValue = 0
  let lagEvidence = 'no version reported, so no lag is computable'
  let lagConfidence = 0.2

  if (reportedLine !== null && frontierLine !== null) {
    const behind = linesBehind(timeline, reportedLine, issue.createdAt)
    lagValue = Math.min(behind, 20) / 20
    lagConfidence = 0.8
    lagEvidence =
      behind === 0
        ? 'reported ' +
          template.nextVersion +
          ', which was the current line when this was filed'
        : behind +
          ' minor line(s) shipped between ' +
          lineLabel(reportedLine) +
          ' and ' +
          lineLabel(frontierLine) +
          ', the line current at filing'
  }

  add(
    signal(
      'version.lag',
      'temporal',
      'Behind the release line at the time of filing',
      lagValue,
      lagConfidence,
      lagEvidence,
    ),
  )

  add(
    signal(
      'version.canary',
      'structural',
      'Testing against canary',
      template.onCanary ? 1 : 0,
      0.92,
      template.onCanary ? template.nextVersion + ' is a prerelease' : 'on a stable release',
    ),
  )

  add(
    signal(
      'canary.box_ticked',
      'structural',
      'Ticked the "verified on canary" box',
      extras.canaryBoxTicked ? 1 : 0,
      // Self-reported and frequently ticked without being true, so the
      // observation is certain but what it means is not.
      0.55,
      extras.canaryBoxTicked ? 'checkbox ticked' : 'checkbox absent or unticked',
    ),
  )

  // ---------------------------------------------------------------- self-triage

  add(
    signal(
      'area.declared',
      'structural',
      'Named the affected area',
      template.areas.length > 0 ? 1 : 0,
      0.85,
      template.areas.length > 0 ? template.areas.join(', ') : 'no area named',
    ),
  )

  add(
    signal(
      'area.unsure',
      'structural',
      'Reporter cannot localise their own bug',
      template.areaUnsure ? 1 : 0,
      0.9,
      template.areaUnsure
        ? 'ticked "Not sure" on the area question'
        : template.declared.length > 0
          ? 'named ' + template.declared.join(', ')
          : 'area question unanswered',
    ),
  )

  add(
    signal(
      'area.scattered',
      'structural',
      'Named many areas at once',
      Math.min(Math.max(template.areas.length - 1, 0), 4) / 4,
      0.8,
      template.areas.length > 2
        ? template.areas.length + ' areas ticked, which usually means unsure'
        : template.areas.length + ' area(s)',
    ),
  )

  // ---------------------------------------------------------------- report body

  add(
    signal(
      'steps.present',
      'textual',
      'Gave steps to reproduce',
      template.hasSteps ? 1 : 0,
      0.8,
      template.hasSteps ? 'numbered or multi-line steps found' : 'no steps found',
    ),
  )

  add(
    signal(
      'stack.present',
      'textual',
      'Included an error or stack trace',
      template.hasStackTrace ? 1 : 0,
      0.85,
      template.hasStackTrace ? 'stack frame or Error type present' : 'no trace',
    ),
  )

  add(
    signal(
      'contrast.present',
      'textual',
      'Said what it does and what it should do',
      template.hasExpectedVsActual ? 1 : 0,
      0.75,
      template.hasExpectedVsActual
        ? 'expected and actual both described'
        : 'no expected-vs-actual contrast',
    ),
  )

  const proseText = prose(issue.body)
  add(
    signal(
      'prose.thin',
      'textual',
      'Almost no prose once template and code are stripped',
      proseText.length < 120 ? 1 - proseText.length / 120 : 0,
      0.9,
      proseText.length + ' characters of prose: "' + snippet(issue.body, 90) + '"',
    ),
  )

  add(
    signal(
      'prose.substantial',
      'textual',
      'A real written description',
      Math.min(proseText.length, 900) / 900,
      0.9,
      proseText.length + ' characters of prose',
    ),
  )

  add(
    signal(
      'title.vague',
      'textual',
      'Title says nothing',
      VAGUE_TITLE.test(issue.title.trim()) ? 1 : issue.title.trim().length < 20 ? 0.6 : 0,
      0.85,
      '"' + issue.title + '"',
    ),
  )

  add(
    signal(
      'title.specific',
      'textual',
      'Title names a symptom precisely',
      /[`'"]|\berror\b.*:|\bcannot\b|\bfails? (to|when)\b|->/i.test(issue.title) &&
        issue.title.length > 30
        ? 1
        : 0,
      0.7,
      '"' + issue.title + '"',
    ),
  )

  // ------------------------------------------------------------ report effort

  add(
    signal(
      'body.has_code',
      'textual',
      'Pasted code or output',
      /```|^ {4,}\S/m.test(issue.body) ? 1 : 0,
      0.9,
      /```/.test(issue.body) ? 'fenced code block present' : 'no code block',
    ),
  )

  const envComplete = Boolean(template.nextVersion && template.nodeVersion && template.os)
  add(
    signal(
      'env.complete',
      'structural',
      'Full environment reported',
      envComplete ? 1 : 0,
      0.92,
      envComplete
        ? 'next ' + template.nextVersion + ', Node ' + template.nodeVersion + ', ' + template.os
        : 'environment block incomplete',
    ),
  )

  add(
    signal(
      'body.substantial',
      'textual',
      'A long report',
      Math.min(issue.body.length, 4000) / 4000,
      0.95,
      issue.body.length + ' characters submitted',
    ),
  )

  add(
    signal(
      'title.length',
      'textual',
      'Title length',
      Math.min(issue.title.length, 110) / 110,
      0.98,
      issue.title.length + ' characters',
    ),
  )

  // ---------------------------------------------------------------- who filed it

  const association = issue.authorAssociation ?? 'NONE'
  add(
    signal(
      'author.newcomer',
      'social',
      'First issue from this person',
      association === 'NONE' || association === 'FIRST_TIME_CONTRIBUTOR' || association === 'FIRST_TIMER'
        ? 1
        : 0,
      0.8,
      'author association: ' + association,
    ),
  )

  add(
    signal(
      'author.insider',
      'social',
      'Filed by a maintainer or collaborator',
      association === 'MEMBER' || association === 'OWNER' || association === 'COLLABORATOR' ? 1 : 0,
      0.95,
      'author association: ' + association,
    ),
  )

  return out
}

/** The fitted feature ids, in a stable order. The contract with weights.json. */
export const FITTED_SIGNAL_IDS = [
  'repro.present',
  'repro.field_blank',
  'repro.field_absent',
  'repro.github',
  'repro.sandbox',
  'repro.placeholder',
  'template.none',
  'template.blank_sections',
  'env.version_present',
  'env.node_present',
  'version.lag',
  'version.canary',
  'canary.box_ticked',
  'area.declared',
  'area.unsure',
  'area.scattered',
  'steps.present',
  'stack.present',
  'contrast.present',
  'prose.thin',
  'prose.substantial',
  'title.vague',
  'title.specific',
  'body.has_code',
  'env.complete',
  'body.substantial',
  'title.length',
  'author.newcomer',
  'author.insider',
] as const

/** The vector the scorer sees: value * confidence, in FITTED_SIGNAL_IDS order. */
export function featureVector(signals: Record<string, Signal>): number[] {
  return FITTED_SIGNAL_IDS.map((id) => {
    const s = signals[id]
    return s ? s.value * s.confidence : 0
  })
}
