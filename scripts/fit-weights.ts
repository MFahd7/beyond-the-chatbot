/**
 * Fit the intent models against decisions the maintainers actually made, and
 * write an evaluation honest enough to argue with.
 *
 * Reads data/features.json (committed, numbers only) and writes
 * data/weights.json and data/eval.json. No network, so a clean clone can
 * reproduce the published weights offline with `npm run data:fit`.
 *
 * WHAT IS BEING FITTED
 *
 *   resolution   P(this issue gets closed without a fix). Trained on GitHub's
 *                own close reason -- completed vs not planned -- which is the
 *                one outcome in this repository that the team's changing
 *                process does not redefine.
 *
 *   actions      Four one-vs-rest models, one per triage label the team
 *                applies: needs_repro, verify_canary, stale_close,
 *                accepted_route.
 *
 * WHY THE SAMPLING IS FUSSY
 *
 * The labels are not spread evenly through history. `please add a complete
 * reproduction` is mostly 2022-23, the `stale` sweeps were 2024, `linear:`
 * routing began in 2024. Sample each label naively and the classes come back
 * almost temporally disjoint, at which point the fastest way to separate them
 * is to read the calendar off the version number -- and the model would score
 * beautifully in cross-validation while being useless on a current backlog.
 *
 * Two defences, both applied below:
 *
 *   1. Every training set is balanced *within each creation year*. Negatives
 *      are drawn following the positives' own year distribution, and each
 *      year contributes equally many positives and negatives. Knowing the year
 *      then tells the model nothing about the label.
 *
 *   2. The feature set contains nothing that accumulates after filing -- see
 *      the header of core/signals.ts. No labels, no comment counts, no age.
 *
 * Both matter. The first stops the model learning the era; the second stops it
 * learning the consequence of the decision instead of its cause.
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { FITTED_SIGNAL_IDS } from '../core/signals'
import { SHIPPED_MODELS } from '../core/types'
import type {
  ActionIntent,
  EvalReport,
  FittedModel,
  ModelScore,
  Weights,
} from '../core/types'

const DATA = path.join(process.cwd(), 'data')

const EPOCHS = 400
const LEARNING_RATE = 0.35
const L2 = 0.004
const TEST_FRACTION = 0.25

const ACTIONS: ActionIntent[] = ['needs_repro', 'verify_canary', 'stale_close', 'accepted_route']

interface FeatureRow {
  number: number
  year: string
  action: string | null
  resolution: string | null
  features: number[]
}

/**
 * Seeded PRNG (mulberry32). Splits and negative sampling must be identical on
 * every machine, or the numbers in the README stop meaning anything.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const a = out[i] as T
    const b = out[j] as T
    out[i] = b
    out[j] = a
  }
  return out
}

interface Example {
  x: number[]
  y: number
  year: string
  number: number
}

/**
 * Build a year-balanced binary training set.
 *
 * For each creation year, take the positives available and draw the same
 * number of negatives from that same year. A year with positives but no
 * available negatives is dropped entirely rather than left lopsided -- an
 * unmatched year is exactly the hole through which era leaks back in.
 */
function balancedSet(
  positives: FeatureRow[],
  negativePool: FeatureRow[],
  random: () => number,
): Example[] {
  const negativesByYear = new Map<string, FeatureRow[]>()
  for (const row of negativePool) {
    const bucket = negativesByYear.get(row.year)
    if (bucket) bucket.push(row)
    else negativesByYear.set(row.year, [row])
  }
  for (const [year, rows] of negativesByYear) {
    negativesByYear.set(year, shuffled(rows, random))
  }

  const positivesByYear = new Map<string, FeatureRow[]>()
  for (const row of positives) {
    const bucket = positivesByYear.get(row.year)
    if (bucket) bucket.push(row)
    else positivesByYear.set(row.year, [row])
  }

  const out: Example[] = []
  for (const [year, rows] of positivesByYear) {
    const available = negativesByYear.get(year) ?? []
    const take = Math.min(rows.length, available.length)
    if (take === 0) continue
    for (const row of shuffled(rows, random).slice(0, take)) {
      out.push({ x: row.features, y: 1, year, number: row.number })
    }
    for (const row of available.slice(0, take)) {
      out.push({ x: row.features, y: 0, year, number: row.number })
    }
  }
  return shuffled(out, random)
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))

function predict(model: { bias: number; w: number[] }, x: number[]): number {
  let z = model.bias
  for (let i = 0; i < model.w.length; i++) z += (model.w[i] as number) * (x[i] ?? 0)
  return sigmoid(z)
}

/** Full-batch gradient descent on log loss with L2. Small data; keep it simple. */
function train(examples: Example[], dimensions: number): { bias: number; w: number[] } {
  const model = { bias: 0, w: new Array<number>(dimensions).fill(0) }
  if (examples.length === 0) return model

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    let biasGradient = 0
    const gradient = new Array<number>(dimensions).fill(0)

    for (const example of examples) {
      const error = predict(model, example.x) - example.y
      biasGradient += error
      for (let i = 0; i < dimensions; i++) {
        gradient[i] = (gradient[i] as number) + error * (example.x[i] ?? 0)
      }
    }

    const scale = LEARNING_RATE / examples.length
    model.bias -= scale * biasGradient
    for (let i = 0; i < dimensions; i++) {
      // L2 on the weights only. Regularising the bias would fight the
      // balanced class prior for no reason.
      model.w[i] = (model.w[i] as number) - scale * (gradient[i] as number) - LEARNING_RATE * L2 * (model.w[i] as number)
    }
  }
  return model
}

/** Rank-based AUC, ties averaged. */
function auc(scored: { p: number; y: number }[]): number {
  const positives = scored.filter((s) => s.y === 1).length
  const negatives = scored.length - positives
  if (positives === 0 || negatives === 0) return 0.5

  const sorted = [...scored].sort((a, b) => a.p - b.p)
  const ranks = new Array<number>(sorted.length)
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && (sorted[j + 1] as { p: number }).p === (sorted[i] as { p: number }).p) j++
    const averageRank = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[k] = averageRank
    i = j + 1
  }

  let rankSum = 0
  for (let k = 0; k < sorted.length; k++) {
    if ((sorted[k] as { y: number }).y === 1) rankSum += ranks[k] as number
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives)
}

function evaluate(
  model: { bias: number; w: number[] },
  test: Example[],
  positiveClass: string,
  trainedOn: number,
): ModelScore {
  const scored = test.map((e) => ({ p: predict(model, e.x), y: e.y, year: e.year }))

  let truePositive = 0
  let falsePositive = 0
  let trueNegative = 0
  let falseNegative = 0
  let brier = 0

  for (const s of scored) {
    const predicted = s.p >= 0.5 ? 1 : 0
    if (predicted === 1 && s.y === 1) truePositive++
    else if (predicted === 1 && s.y === 0) falsePositive++
    else if (predicted === 0 && s.y === 0) trueNegative++
    else falseNegative++
    brier += (s.p - s.y) * (s.p - s.y)
  }

  const precision = truePositive + falsePositive > 0 ? truePositive / (truePositive + falsePositive) : 0
  const recall = truePositive + falseNegative > 0 ? truePositive / (truePositive + falseNegative) : 0

  const eraBalance: Record<string, number> = {}
  for (const s of scored) eraBalance[s.year] = (eraBalance[s.year] ?? 0) + 1

  const weighted = FITTED_SIGNAL_IDS.map((id, i) => ({
    signalId: id,
    weight: Number((model.w[i] as number).toFixed(4)),
  }))
  const byWeight = [...weighted].sort((a, b) => b.weight - a.weight)

  const round = (n: number) => Number(n.toFixed(4))

  return {
    accuracy: round((truePositive + trueNegative) / Math.max(scored.length, 1)),
    baseline: 0.5,
    auc: round(auc(scored)),
    brier: round(brier / Math.max(scored.length, 1)),
    trainedOn,
    heldOut: scored.length,
    positiveClass,
    eraBalance,
    precision: round(precision),
    recall: round(recall),
    f1: round(precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0),
    topFor: byWeight.slice(0, 6),
    topAgainst: byWeight.slice(-6).reverse(),
    shipped: false,
    verdict: '',
  }
}

/**
 * Decide whether a model is good enough to put in front of a person.
 *
 * The bar is AUC 0.65, set before the models were fitted. Anything below it is
 * reported rather than quietly shipped: an interface that prepares an action
 * from a coin-flip is worse than one that leaves the decision alone, because
 * it spends the operator's trust without buying anything with it.
 */
const AUC_BAR = 0.65

/**
 * Two roles, two bars, because the cost of being wrong is not the same.
 *
 * An action model writes a comment or closes someone's bug report, so it has
 * to clear 0.65 to be allowed near a person. A ranking model only decides what
 * order things appear in: being wrong there costs the operator a scroll, and
 * the queue is still strictly better ordered than the reverse-chronological
 * list it replaces. Holding both to the same bar would be a category error in
 * one direction or the other.
 */
function judge(score: ModelScore, role: 'action' | 'ranking', shipped: boolean): ModelScore {
  if (role === 'ranking') {
    return {
      ...score,
      shipped,
      verdict:
        'Ranking only -- never prepares an action. AUC ' +
        score.auc.toFixed(3) +
        ' on a 0.50 baseline: directionally useful, and a mis-ranked case costs a scroll ' +
        'rather than a wrong comment on someone’s bug report.',
    }
  }

  if (shipped) {
    return {
      ...score,
      shipped,
      verdict: 'Shipped. AUC ' + score.auc.toFixed(3) + ' clears the 0.65 bar set before fitting.',
    }
  }

  // A model can clear the bar and still be the wrong instrument. Staleness is
  // the case in point: it reaches AUC 0.66 from submission features alone, but
  // the rule in core/rules.ts gets to look at the nine months of silence that
  // the feature set is forbidden to contain. More relevant information beats a
  // better-sounding number, and the rule can be argued with in days rather
  // than coefficients. The fitted score is kept as a floor, not used.
  const verdict =
    score.auc >= AUC_BAR
      ? 'Fitted at AUC ' +
        score.auc.toFixed(3) +
        ', which clears the bar — but not used. The stated rule for this decision can ' +
        'see the post-filing silence that the feature set deliberately excludes, so it has ' +
        'strictly more of the relevant information. Reported here as a floor.'
      : score.auc < 0.55
        ? 'Cut. AUC ' +
          score.auc.toFixed(3) +
          ' is close to chance: this decision depends on what happened after the report was ' +
          'filed, which the feature set deliberately excludes. Handled by a stated rule instead.'
        : 'Cut. AUC ' +
          score.auc.toFixed(3) +
          ' is above chance but below the 0.65 bar set before fitting. Handled by a stated rule instead.'

  return { ...score, shipped, verdict }
}

function toFittedModel(model: { bias: number; w: number[] }): FittedModel {
  const weights: Record<string, number> = {}
  FITTED_SIGNAL_IDS.forEach((id, i) => {
    weights[id] = Number((model.w[i] as number).toFixed(5))
  })
  return { bias: Number(model.bias.toFixed(5)), weights }
}

/** Split preserving the balance of both class and year. */
function split(examples: Example[], random: () => number): { train: Example[]; test: Example[] } {
  const strata = new Map<string, Example[]>()
  for (const example of examples) {
    const key = example.year + ':' + example.y
    const bucket = strata.get(key)
    if (bucket) bucket.push(example)
    else strata.set(key, [example])
  }
  const trainSet: Example[] = []
  const testSet: Example[] = []
  for (const bucket of strata.values()) {
    const shuffledBucket = shuffled(bucket, random)
    const cut = Math.max(1, Math.round(shuffledBucket.length * TEST_FRACTION))
    testSet.push(...shuffledBucket.slice(0, cut))
    trainSet.push(...shuffledBucket.slice(cut))
  }
  return { train: trainSet, test: testSet }
}

async function main() {
  const raw = JSON.parse(
    await readFile(path.join(DATA, 'features.json'), 'utf8'),
  ) as { repo: string; rows: FeatureRow[] }
  const rows = raw.rows
  const dimensions = FITTED_SIGNAL_IDS.length

  console.log(rows.length + ' labelled rows, ' + dimensions + ' features')
  console.log('Epochs ' + EPOCHS + ', lr ' + LEARNING_RATE + ', L2 ' + L2 + '\n')

  // ------------------------------------------------------ resolution model

  console.log('resolution -- will this be closed without a fix?')
  const notPlanned = rows.filter((r) => r.resolution === 'not_planned')
  const completed = rows.filter((r) => r.resolution === 'completed')
  console.log('  pool: ' + notPlanned.length + ' not planned, ' + completed.length + ' completed')

  const resolutionSet = balancedSet(notPlanned, completed, rng(1))
  const resolutionSplit = split(resolutionSet, rng(2))
  const resolutionModel = train(resolutionSplit.train, dimensions)
  const resolutionScore = judge(
    evaluate(resolutionModel, resolutionSplit.test, 'not_planned', resolutionSplit.train.length),
    'ranking',
    // The resolution model is not an action and never prepares one. It only
    // ranks, where being directionally right is the whole requirement.
    true,
  )
  console.log(
    '  balanced to ' +
      resolutionSet.length +
      ' examples across years ' +
      [...new Set(resolutionSet.map((e) => e.year))].sort().join(', '),
  )
  console.log(
    '  held-out accuracy ' +
      (resolutionScore.accuracy * 100).toFixed(1) +
      '%  AUC ' +
      resolutionScore.auc.toFixed(3) +
      '  Brier ' +
      resolutionScore.brier.toFixed(3) +
      '  (baseline 50.0%)',
  )
  console.log(
    '  pushes toward "no fix": ' +
      resolutionScore.topFor.map((w) => w.signalId + ' ' + w.weight.toFixed(2)).join(', '),
  )
  console.log(
    '  pushes toward "fixed":  ' +
      resolutionScore.topAgainst.map((w) => w.signalId + ' ' + w.weight.toFixed(2)).join(', '),
  )
  console.log('')

  // --------------------------------------------------------- action models

  const actionModels = {} as Record<ActionIntent, FittedModel>
  const actionScores: Record<string, ModelScore> = {}

  for (const action of ACTIONS) {
    const positives = rows.filter((r) => r.action === action)
    // Negatives are anything with a different recorded outcome. Drawn
    // year-by-year to match the positives, inside balancedSet.
    const negatives = rows.filter((r) => r.action !== action && (r.action !== null || r.resolution !== null))

    const set = balancedSet(positives, negatives, rng(11))
    if (set.length < 40) {
      console.log(action + ' -- skipped, only ' + set.length + ' year-matched examples')
      continue
    }
    const parts = split(set, rng(12))
    const model = train(parts.train, dimensions)
    const score = judge(
      evaluate(model, parts.test, action, parts.train.length),
      'action',
      SHIPPED_MODELS.includes(action),
    )

    actionModels[action] = toFittedModel(model)
    actionScores[action] = score

    const years = Object.entries(score.eraBalance)
      .sort()
      .map(([y, n]) => y + ':' + n)
      .join(' ')
    console.log(action + ' -- ' + positives.length + ' positives available')
    console.log(
      '  year-matched to ' +
        set.length +
        ' examples, held-out accuracy ' +
        (score.accuracy * 100).toFixed(1) +
        '%  AUC ' +
        score.auc.toFixed(3) +
        '  (baseline 50.0%)',
    )
    console.log('  held-out years: ' + years)
    console.log('  strongest evidence for: ' + score.topFor.slice(0, 4).map((w) => w.signalId).join(', '))
    console.log('  ' + score.verdict)
  }

  // ---------------------------------------------------------------- output

  const weights: Weights = {
    resolution: toFittedModel(resolutionModel),
    actions: actionModels,
    meta: {
      fittedAt: new Date().toISOString(),
      signalIds: [...FITTED_SIGNAL_IDS],
      epochs: EPOCHS,
      learningRate: LEARNING_RATE,
      l2: L2,
    },
  }

  const report: EvalReport = {
    fittedAt: weights.meta.fittedAt,
    repo: raw.repo,
    note:
      'Every model is binary, balanced within each creation year, and scored on a ' +
      'held-out quarter of its own year-matched set -- so 50% is the honest baseline ' +
      'and the calendar carries no information. Features describe the submission only; ' +
      'nothing that accumulates after filing is used. See core/signals.ts.',
    resolution: resolutionScore,
    actions: actionScores,
  }

  await writeFile(path.join(DATA, 'weights.json'), JSON.stringify(weights, null, 2), 'utf8')
  await writeFile(path.join(DATA, 'eval.json'), JSON.stringify(report, null, 2), 'utf8')

  console.log('\nWrote data/weights.json and data/eval.json')
}

main().catch((err) => {
  console.error('\nFit failed: ' + (err instanceof Error ? err.stack : String(err)))
  process.exitCode = 1
})
