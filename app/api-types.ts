/**
 * The wire format between the server and the interface.
 *
 * Deliberately not the internal `Case`. The corpus is 9 MB of issue bodies and
 * the full inference for 67 cases carries every signal, every contribution and
 * every drafted mutation -- several megabytes to render a screen that shows
 * one decision. So the route sends what a card actually displays, and the card
 * asks for more only when the operator opens the evidence panel.
 *
 * The operator model travels the other way on every request. That keeps the
 * server a pure function of (corpus, weights, model, clock) with no session
 * state, which matters for two reasons: the docket is reproducible from what
 * the client holds, and nothing breaks when a serverless instance is recycled
 * between one keystroke and the next.
 */

import type { CaseKind, OperatorModel, RejectReason, Verdict } from '@/core/types'

export interface WireIssue {
  number: number
  title: string
  url: string
  reactions: number
  comments: number
  ageDays: number
  idleDays: number
  version: string | null
  areas: string[]
  /** A quotable fragment of what the reporter wrote, scaffolding removed. */
  snippet: string
}

export interface WireSignal {
  id: string
  kind: string
  label: string
  value: number
  confidence: number
  evidence: string
  /** The fitted weight and signed push, when a model produced this. */
  weight?: number
  push?: number
}

export interface WireMutation {
  kind: string
  issue: number
  payload: string
  request: string
  stage: 'auto' | 'review'
}

export interface WireAction {
  summary: string
  reversal: string
  reversibility: number
  /** A sample; `total` says how many there really are. */
  mutations: WireMutation[]
  total: number
  autonomous: number
}

export interface WireCase {
  id: string
  kind: CaseKind
  headline: string
  situation: string
  confidence: number
  margin: number
  deadEnd: number
  ev: number
  impact: number
  impactUnit: string
  effort: number
  autoAfter: number | null
  explain: string[]
  provenance: { source: 'model' | 'rule' | 'clustering'; detail: string }
  signals: WireSignal[]
  action: WireAction
  issues: WireIssue[]
  /** Every candidate action considered, so the card can show the runner-up. */
  alternatives: { intent: string; probability: number }[]
  sweep: { count: number; basis: string; autoCount: number; drivers: string[] } | null
}

export interface WireSuppressed {
  id: string
  kind: string
  issues: number[]
  headline: string
  confidence: number
  why: string
}

/**
 * The comparison view's data: the same issues, in the order the interface
 * being replaced would show them. Reverse-chronological, because that is what
 * an issue tracker does.
 */
export interface WireBacklogRow {
  number: number
  title: string
  url: string
  labels: string[]
  comments: number
  reactions: number
  ageDays: number
  author: string | null
}

export interface WireMeta {
  repo: string
  fetchedAt: string
  builtAt: string
  openIssues: number
  openReported: number
  trainingRows: number
  vocabulary: number
  clusters: number
  /** Held-out scores, straight out of data/eval.json. */
  models: {
    id: string
    accuracy: number
    auc: number
    baseline: number
    heldOut: number
    shipped: boolean
    verdict: string
  }[]
}

export interface DocketResponse {
  cases: WireCase[]
  suppressed: WireSuppressed[]
  stats: {
    openIssues: number
    openReported: number
    cases: number
    decisions: number
    sweeps: number
    issuesCovered: number
    suppressed: number
    issuesWithheld: number
    byKind: Record<string, number>
    autoQueued: number
    minutesOfWork: number
  }
  backlog: WireBacklogRow[]
  meta: WireMeta
  /** Server clock used to build this docket, so replays line up. */
  now: string
}

export interface DocketRequest {
  model?: OperatorModel
  /** Overrides the clock. Used by tests and the recorded walkthrough. */
  now?: string
}

export interface FeedbackRequest {
  model: OperatorModel
  caseId: string
  verdict: Verdict
  reason?: RejectReason | null
  now?: string
}
