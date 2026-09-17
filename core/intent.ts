/**
 * Decide what should happen to one issue next.
 *
 * Three sources, and the interface never blurs them:
 *
 *   fitted     needs_repro and accepted_route, from logistic models fitted on
 *              3,100 real maintainer decisions. Reported with a probability.
 *   rules      stale_close and verify_canary, from thresholds in core/rules.ts.
 *              Reported with the threshold that fired.
 *   clusters   dedupe, from unsupervised similarity. Reported with cohesion.
 *
 * The output is not a label. It is a label plus the margin to the runner-up,
 * because the margin is what decides how the interface behaves: a wide margin
 * earns a prepared action that can apply itself, a narrow one earns a visible
 * hedge and nothing happens without a keystroke. A classifier that is 51%
 * confident and a classifier that is 94% confident should not produce the same
 * screen, and in most products they do.
 */

import type {
  ActionIntent,
  Contribution,
  Inference,
  IntentScore,
  Issue,
  Signal,
  TemplateFields,
  Weights,
} from './types'
import { SHIPPED_MODELS } from './types'
import { FITTED_SIGNAL_IDS } from './signals'
import { canaryRule, staleRule, type RuleHit } from './rules'
import type { VersionTimeline } from './signals'

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))

/**
 * Score one fitted model and keep the arithmetic. `contributions` is not
 * decoration: it is what the evidence panel renders, and it is the only reason
 * a maintainer can tell "no reproduction" from "wrote three words" when both
 * produce the same verdict.
 */
export function scoreModel(
  model: { bias: number; weights: Record<string, number> },
  signals: Record<string, Signal>,
  trust: Record<string, number> = {},
): { logit: number; probability: number; contributions: Contribution[] } {
  let logit = model.bias
  const contributions: Contribution[] = []

  for (const id of FITTED_SIGNAL_IDS) {
    const signal = signals[id]
    const weight = model.weights[id] ?? 0
    if (!signal || weight === 0) continue

    // The operator's trust multiplier rides on the signal, not the weight, so
    // a signal the operator has rejected twice stops carrying every model at
    // once rather than needing to be re-learned per decision type.
    const multiplier = trust[id] ?? 1
    const value = signal.value * signal.confidence * multiplier
    const push = weight * value
    logit += push

    if (Math.abs(push) > 0.005) {
      contributions.push({
        signalId: id,
        label: signal.label,
        weight: Number(weight.toFixed(4)),
        value: Number(signal.value.toFixed(4)),
        confidence: Number(signal.confidence.toFixed(4)),
        push: Number(push.toFixed(4)),
      })
    }
  }

  contributions.sort((a, b) => Math.abs(b.push) - Math.abs(a.push))
  return { logit, probability: sigmoid(logit), contributions }
}

export interface IntentInput {
  issue: Issue
  template: TemplateFields
  signals: Record<string, Signal>
  canaryBoxTicked: boolean
  timeline: VersionTimeline
  weights: Weights
  trust?: Record<string, number>
  now: Date
}

export interface IntentResult {
  inference: Inference
  /** Rule outcomes, whether or not they fired. The road not taken. */
  rules: Record<'stale_close' | 'verify_canary', RuleHit>
  /** Signals the rules contributed, for the evidence panel. */
  ruleSignals: Signal[]
}

/**
 * Turn probabilities and rule strengths into one ranked answer.
 *
 * Rule strengths are not probabilities and are not pretended to be. They enter
 * the comparison at a deliberate discount, because a threshold being crossed
 * is weaker evidence about what to do than a model that has been measured
 * against several hundred real decisions. If a fitted model and a rule both
 * want the issue, the fitted model wins unless the rule is emphatic.
 */
const RULE_DISCOUNT = 0.82

export function inferIntent(input: IntentInput): IntentResult {
  const { issue, template, signals, timeline, weights, trust = {}, now } = input

  const stale = staleRule(issue, now)
  const canary = canaryRule(issue, template, timeline, input.canaryBoxTicked, now)

  const scores: IntentScore[] = []

  for (const action of SHIPPED_MODELS) {
    const model = weights.actions[action]
    if (!model) continue
    const scored = scoreModel(model, signals, trust)
    scores.push({
      intent: action,
      logit: Number(scored.logit.toFixed(4)),
      probability: Number(scored.probability.toFixed(4)),
      contributions: scored.contributions,
    })
  }

  const ruleEntries: { intent: ActionIntent; hit: RuleHit }[] = [
    { intent: 'stale_close', hit: stale },
    { intent: 'verify_canary', hit: canary },
  ]

  for (const { intent, hit } of ruleEntries) {
    scores.push({
      intent,
      logit: 0,
      probability: Number((hit.strength * RULE_DISCOUNT).toFixed(4)),
      contributions: hit.signals.map((signal) => ({
        signalId: signal.id,
        label: signal.label,
        weight: 0,
        value: Number(signal.value.toFixed(4)),
        confidence: signal.confidence,
        push: Number((signal.value * signal.confidence).toFixed(4)),
      })),
    })
  }

  scores.sort((a, b) => b.probability - a.probability)

  const top = scores[0] as IntentScore
  const runnerUp = (scores[1] ?? top) as IntentScore
  const margin = Number((top.probability - runnerUp.probability).toFixed(4))

  const resolution = scoreModel(weights.resolution, signals, trust)

  return {
    inference: {
      top: top.intent,
      runnerUp: runnerUp.intent,
      margin,
      // Confidence is the winner's own probability tempered by how close the
      // runner-up came. Two decisions at 0.8 are not equally safe if one of
      // them has something else at 0.79.
      confidence: Number((top.probability * (0.55 + 0.45 * Math.min(margin / 0.3, 1))).toFixed(4)),
      deadEnd: Number(resolution.probability.toFixed(4)),
      scores,
    },
    rules: { stale_close: stale, verify_canary: canary },
    ruleSignals: [...stale.signals, ...canary.signals],
  }
}

/** Which source produced a decision. The interface labels every card with this. */
export function provenanceOf(kind: string): {
  source: 'model' | 'rule' | 'clustering'
  detail: string
} {
  if (kind === 'needs_repro') {
    return { source: 'model', detail: 'logistic model, held-out AUC 0.71 on 800 year-matched examples' }
  }
  if (kind === 'accepted_route' || kind === 'escalate') {
    return { source: 'model', detail: 'logistic model, held-out AUC 0.75 on 786 year-matched examples' }
  }
  if (kind === 'dedupe') {
    return { source: 'clustering', detail: 'unsupervised: no ground truth exists for duplicates in this repo' }
  }
  return { source: 'rule', detail: 'stated threshold, not a fitted model' }
}
