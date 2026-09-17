/**
 * The vocabulary of the pipeline.
 *
 * Data flows one way: Issue -> Signal[] -> Inference -> Case -> DraftAction.
 * Nothing downstream is allowed to reach back and change something upstream,
 * which is what makes the whole thing replayable from a corpus and an
 * OperatorModel alone.
 */

/** One real issue, slimmed to the fields the pipeline actually reads. */
export interface Issue {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  stateReason: string | null
  labels: string[]
  createdAt: string
  updatedAt: string
  closedAt: string | null
  comments: number
  reactions: number
  author: string | null
  authorAssociation: string | null
  assignees: string[]
  milestone: string | null
  locked: boolean
  url: string
}

/**
 * What the repo's own bug template asks for, as actually filled in.
 *
 * This is the highest-value structure in the corpus: the template is a form,
 * people fill it in badly, and the specific way it is filled in badly is what
 * decides the triage outcome. `templateUsed: false` is itself a strong signal.
 */
export interface TemplateFields {
  templateUsed: boolean
  reproUrl: string | null
  reproKind: 'github' | 'sandbox' | 'private' | 'none'
  /** Version string as the reporter wrote it, e.g. "15.4.2" or "16.0.0-canary.31". */
  nextVersion: string | null
  nextVersionOrder: number | null
  onCanary: boolean
  nodeVersion: string | null
  os: string | null
  /**
   * From "Which area(s) are affected?", narrowed to areas that exist as real
   * labels, so they are safe to apply to the issue.
   */
  areas: string[]
  /**
   * What the reporter actually ticked, including options with no matching
   * label ("App Router", "Developer Experience"). Good enough to group a
   * sweep by; not safe to apply. See core/templates.ts.
   */
  declared: string[]
  /** The reporter ticked "Not sure": they cannot localise their own bug. */
  areaUnsure: boolean
  stages: string[]
  hasStackTrace: boolean
  hasSteps: boolean
  hasExpectedVsActual: boolean
  /** Characters of prose left once template scaffolding and code are removed. */
  proseLength: number
}

export type SignalKind = 'structural' | 'textual' | 'temporal' | 'social' | 'model'

/**
 * One observation about one issue.
 *
 * `value` is normalised to 0..1 so the scorer can hold every signal to the same
 * scale. `confidence` is separate on purpose: "this issue has no reproduction
 * link" is an almost certain observation, while "this text reads like a
 * duplicate of #84123" is a guess. The scorer multiplies the two, so a
 * confident-but-irrelevant signal and a relevant-but-shaky one are told apart.
 *
 * `evidence` must quote something real -- a number, a substring, an issue
 * number. Anything that cannot cite itself does not get to be a signal.
 */
export interface Signal {
  id: string
  kind: SignalKind
  label: string
  value: number
  confidence: number
  evidence: string
}

/**
 * The four triage actions that were fitted and measured. Each is a real label
 * in the repo's taxonomy, so each model answers a question a maintainer has
 * already answered a few hundred times.
 */
export type ActionIntent = 'needs_repro' | 'verify_canary' | 'stale_close' | 'accepted_route'

/**
 * Of those four, the two the interface actually uses.
 *
 * The split is not arbitrary and it is not a hedge -- it falls exactly along
 * the line drawn in core/signals.ts. Fitted features describe the submission
 * only, because a feature that accumulates after filing would let the model
 * read the outcome off the back of the card. So the models can only be good at
 * decisions that are predictable from the report as written.
 *
 *   needs_repro      AUC 0.77. Is this report actionable as it stands? That is
 *   accepted_route   AUC 0.78. entirely a property of what was submitted.
 *
 *   stale_close      AUC 0.66. Whether an issue is going nowhere depends on
 *   verify_canary    AUC 0.55. the silence that followed it, and on where the
 *                    release line has moved since -- neither of which is in
 *                    the report.
 *
 * verify_canary is near chance and was cut outright. stale_close is the
 * interesting one: it clears the 0.65 bar, and is still not used. The rule in
 * core/rules.ts gets to look at the nine months of silence and the absence of
 * anyone waiting -- the exact facts the feature set is forbidden to contain --
 * so it holds strictly more of the relevant information than the model that
 * beat the bar without them. More information wins over a better number, and
 * "quiet for 274 days, nobody assigned" is something a maintainer can argue
 * with in a way a coefficient is not.
 *
 * Both are still in data/weights.json and data/eval.json so the claim can be
 * checked rather than taken on trust.
 *
 * None of this is a limitation being worked around. Age and silence are
 * perfectly observable on an *open* issue; the only thing they could never do
 * was serve as training features against a historical label.
 */
export const SHIPPED_MODELS: ActionIntent[] = ['needs_repro', 'accepted_route']

/** Decisions made by a stated threshold rather than a fitted model. */
export type RuleKind = 'verify_canary' | 'stale_close' | 'dedupe'

/**
 * What the docket can surface. `dedupe` comes from unsupervised clustering
 * rather than a fitted model, and `escalate` is `accepted_route` with the
 * blast radius to justify jumping the queue -- the interface labels both
 * honestly instead of letting them borrow the classifier's credibility.
 */
export type CaseKind = ActionIntent | 'dedupe' | 'escalate'

export interface Contribution {
  signalId: string
  label: string
  weight: number
  value: number
  confidence: number
  /** weight * value * confidence -- the signed push this signal gave. */
  push: number
}

export interface IntentScore {
  intent: ActionIntent
  logit: number
  probability: number
  contributions: Contribution[]
}

/**
 * The classifier's answer. `margin` is the gap to the runner-up, and it is the
 * number the interface cares about most: a wide margin earns a prepared action,
 * a narrow one earns a visible hedge.
 *
 * `deadEnd` is the separate, era-stable model: the probability this report gets
 * closed without anyone fixing anything. It is not one of the actions. It says
 * how much of the maintainer's attention the report deserves at all.
 */
export interface Inference {
  top: ActionIntent
  runnerUp: ActionIntent
  margin: number
  confidence: number
  deadEnd: number
  scores: IntentScore[]
}

/** A GitHub mutation, described precisely enough to be executed or audited. */
export interface Mutation {
  kind: 'label' | 'unlabel' | 'comment' | 'close' | 'assign' | 'milestone'
  issue: number
  /** The exact label name, comment body, or close reason. */
  payload: string
  /** The REST call this becomes, shown in the interface verbatim. */
  request: string
  /**
   * Whether this mutation may apply itself.
   *
   * The gate is reversibility, not confidence. A label goes on and comes off
   * and nobody is notified, so a confident model is allowed to apply one. A
   * comment lands in the inbox of everyone watching the issue the instant it
   * posts, and deleting it afterwards does not unsend the mail -- so no
   * confidence score buys permission to send one. Closing someone's bug report
   * is likewise a person's decision.
   *
   * The practical effect is that autonomy and irreversibility are separated:
   * the system does the filing on its own and leaves the talking to a human.
   */
  stage: 'auto' | 'review'
}

export interface DraftAction {
  summary: string
  /** For a sweep this holds every mutation; the interface renders a sample. */
  mutations: Mutation[]
  /** What it costs to undo this if it turns out to be wrong. */
  reversal: string
  reversibility: number
  /** The subset that can apply itself, if any. */
  autonomous: Mutation[]
}

/**
 * One decision, ready for a verdict. This is the only object the interface
 * renders. A Case can cover several issues at once -- that is the whole point
 * of the dedupe kind.
 */
export interface Case {
  id: string
  kind: CaseKind
  issues: Issue[]
  /** The single sentence that goes at the top. Written to be read once. */
  headline: string
  /** Two or three sentences of situation, only if the headline needs support. */
  situation: string
  signals: Signal[]
  inference: Inference
  action: DraftAction
  /** People affected if this is right, in whatever unit the kind deals in. */
  impact: number
  impactUnit: string
  /** Minutes of maintainer time this decision costs if taken by hand. */
  effort: number
  /** Expected value of attention. The ranking key. */
  ev: number
  /**
   * Where this decision came from: a fitted model, a stated rule, or
   * unsupervised clustering.
   *
   * On the Case rather than assembled in the API layer, because it is a
   * property of the decision itself. A fitted model, a threshold and a cluster
   * are three different kinds of claim, and a system that cannot say which one
   * it is holding has no way to stop the unmeasured parts from borrowing the
   * measured parts' credibility.
   */
  provenance: { source: 'model' | 'rule' | 'clustering'; detail: string }
  /** Seconds until this applies itself, or null if it never will. */
  autoAfter: number | null
  explain: string[]
  /**
   * A sweep covers many issues that all want the same mechanical action.
   *
   * The distinction is the core of the interface. Some decisions are judgments
   * about one issue -- is this a duplicate of that, does this regression
   * deserve to jump the queue -- and they get a card each. Others are the same
   * keystroke applied 112 times, where the real question is not "what about
   * this issue" but "do I trust this rule on this set". Showing those as 112
   * cards is how a decision queue turns back into a backlog.
   *
   * A sweep is reviewed by sampling: the card shows the rule, the count, and a
   * handful of members to spot-check, and the operator can drop any of them.
   */
  sweep: {
    /** How many issues the sweep covers. */
    count: number
    /** The rule or model that selected them, in one line. */
    basis: string
    /** Issues to spot-check, highest engagement first. */
    sample: number[]
    /**
     * The fitted signals that put these members here, most frequent first.
     *
     * Without this a sweep had nothing to distrust. Its only evidence rows
     * were `sweep.size` and `sweep.agreement`, which are descriptions of the
     * sweep rather than features of any model -- so rejecting a 55-issue sweep
     * as misread would dutifully record an adjustment against two ids that
     * feed nothing, and change no future decision at all. A correction that
     * silently does nothing is worse than no correction, because the operator
     * believes they have taught the system something.
     */
    drivers: string[]
    /** The high-confidence subset allowed to apply itself. */
    autoCount: number
  } | null
}

/**
 * Everything the docket learned from this operator, and the only mutable state
 * in the system. Held by the client and posted with each request, so the server
 * stays a pure function of (corpus, model).
 */
export interface OperatorModel {
  /** Multiplier per signal id. Starts at 1, moves when the operator rejects. */
  signalTrust: Record<string, number>
  /** Multiplier per area label. Encodes "this is not my code". */
  areaInterest: Record<string, number>
  /** Multiplier per case kind. Encodes "stop showing me stale closes". */
  kindInterest: Record<string, number>
  /** Case ids the operator deferred, with the time they come back. */
  snoozed: Record<string, string>
  /** Case ids already decided, so they do not reappear. */
  settled: string[]
  /** Newest first. Drives the "what changed" panel. */
  history: FeedbackEvent[]
}

export type Verdict = 'approve' | 'edit' | 'reject' | 'snooze'

export type RejectReason =
  | 'wrong_situation'
  | 'wrong_action'
  | 'wrong_priority'
  | 'not_my_area'
  | 'stale_evidence'

export interface FeedbackEvent {
  caseId: string
  kind: CaseKind
  verdict: Verdict
  reason: RejectReason | null
  at: string
  /** Signal ids and multipliers this event moved, for the "what changed" panel. */
  adjustments: { target: string; from: number; to: number; note: string }[]
}

export interface FittedModel {
  bias: number
  weights: Record<string, number>
}

/** The fitted models, written by scripts/fit-weights.ts. */
export interface Weights {
  /** P(closed without a fix). Era-stratified, so it cannot read the calendar. */
  resolution: FittedModel
  /** One-vs-rest per triage action, each against era-matched negatives. */
  actions: Record<ActionIntent, FittedModel>
  meta: {
    fittedAt: string
    signalIds: string[]
    epochs: number
    learningRate: number
    l2: number
  }
}

export interface ModelScore {
  /** Fraction of held-out examples classified correctly. */
  accuracy: number
  /** Always 0.5 here: every training set is balanced, so coin-flip is the bar. */
  baseline: number
  /** Ranking quality, independent of where the threshold sits. */
  auc: number
  /** Calibration. Lower is better; 0.25 is what guessing 0.5 every time scores. */
  brier: number
  trainedOn: number
  heldOut: number
  positiveClass: string
  /** Held-out examples per creation year, to show the era balance held. */
  eraBalance: Record<string, number>
  precision: number
  recall: number
  f1: number
  /** Signals pushing hardest toward and away from the positive class. */
  topFor: { signalId: string; weight: number }[]
  topAgainst: { signalId: string; weight: number }[]
  /** Whether the interface uses this model. See SHIPPED_MODELS. */
  shipped: boolean
  verdict: string
}

export interface EvalReport {
  fittedAt: string
  repo: string
  note: string
  resolution: ModelScore
  actions: Record<string, ModelScore>
}

/** Provenance for the corpus, shown in the interface so the data can be checked. */
export interface CorpusMeta {
  repo: string
  fetchedAt: string
  builtAt: string
  openCount: number
  openTotalReported: number
  trainingCount: number
  classes: { id: string; means: string; query: string; fetched: number }[]
  clusterCount: number
  clusteredIssues: number
  vocabulary: number
  similarityThreshold: number
}

/** Mirrors TemplateExtras in core/templates.ts, kept here to avoid a cycle. */
export interface TemplateExtrasRecord {
  reproFieldPresent: boolean
  reproIsPlaceholder: boolean
  generation: 'current' | 'legacy' | 'none'
  blankSections: number
  canaryBoxTicked: boolean
}

export interface DuplicateCluster {
  id: string
  members: number[]
  canonical: number
  /** Mean pairwise cosine similarity inside the cluster. */
  cohesion: number
  /** The tokens that made them look alike, highest idf first. */
  sharedTerms: string[]
  /** Per-member similarity to the canonical issue. */
  similarities: Record<number, number>
}

export interface Corpus {
  meta: CorpusMeta
  open: Issue[]
  templates: Record<number, TemplateFields>
  /** Structural facts that are not template fields. See core/templates.ts. */
  extras: Record<number, TemplateExtrasRecord>
  features: Record<number, Record<string, Signal>>
  clusters: DuplicateCluster[]
  /** Release timeline parsed out of the versions people report. */
  versions: { version: string; order: number; firstSeen: string; reports: number }[]
}
