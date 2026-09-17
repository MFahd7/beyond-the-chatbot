/**
 * FAILURE A -- the interface reads an issue wrong.
 *
 * The scenario the brief asks about. The docket has put a case at the top and
 * prepared an action for it, and the maintainer looks at it and says: no, you
 * have misunderstood this issue. Not "wrong priority", not "not my area" --
 * the reading itself is wrong.
 *
 * What has to happen next, in order:
 *
 *   1. The case goes away and does not come back.
 *   2. The signals that drove that reading lose trust -- everywhere they
 *      appear, not just on this decision type, because a signal that lied once
 *      is a signal that will lie in the next model that uses it.
 *   3. The operator is shown exactly what moved, in numbers.
 *   4. The docket reorders, and the reordering is visible.
 *   5. Nothing else is damaged: other signals, other kinds and other areas are
 *      left where they were.
 *
 * The thing being tested is that a correction is cheap and specific. If
 * rejecting one card degraded the whole model, nobody would reject a second
 * one, and the interface would quietly become a thing people click through.
 */

import { describe, expect, it } from 'vitest'

import { buildDocket } from '@/core/docket'
import { applyFeedback, deviations, emptyModel, targetOf } from '@/core/operator'
import { builtAt, corpus, weights } from './support'

const build = (model = emptyModel()) =>
  buildDocket({ corpus: corpus(), weights: weights(), model, now: builtAt() })

describe('failure A: the reading was wrong', () => {
  it('recovers specifically, visibly, and without collateral damage', () => {
    const before = build()

    // Take the first case decided by a fitted model, since that is the one
    // with signal contributions to distrust.
    const target = before.cases.find(
      (kase) => kase.provenance.source === 'model' && kase.signals.length > 0,
    )
    expect(target, 'expected at least one model-driven case in the docket').toBeDefined()
    if (!target) return

    const drivers = targetOf(target).drivers
    expect(drivers.length).toBeGreaterThan(0)

    const { model, event, summary } = applyFeedback({
      model: emptyModel(),
      target: targetOf(target),
      verdict: 'reject',
      reason: 'wrong_situation',
      now: builtAt(),
    })

    // 1. Gone, and recorded as settled so it cannot resurface.
    expect(model.settled).toContain(target.id)
    const after = build(model)
    expect(after.cases.find((c) => c.id === target.id)).toBeUndefined()

    // 2. The signals that drove the reading lost trust.
    for (const signalId of drivers) {
      expect(model.signalTrust[signalId]).toBeLessThan(1)
      expect(model.signalTrust[signalId]).toBeGreaterThanOrEqual(0.1)
    }

    // 3. The operator can see what moved, with before and after values.
    expect(event.adjustments.length).toBe(drivers.length)
    for (const adjustment of event.adjustments) {
      expect(adjustment.from).toBeGreaterThan(adjustment.to)
      expect(adjustment.note.length).toBeGreaterThan(0)
    }
    expect(summary.join(' ')).toContain('signal')

    // 4. The change reaches the ranking rather than only the audit log: the
    // distrusted signals feed every model, so scores move.
    const survivors = new Set(after.cases.map((c) => c.id))
    const comparable = before.cases.filter((c) => survivors.has(c.id))
    const moved = comparable.filter((c) => {
      const now = after.cases.find((x) => x.id === c.id)
      return now !== undefined && Math.abs(now.ev - c.ev) > 0.001
    })
    expect(moved.length).toBeGreaterThan(0)

    // 5. Nothing else was touched. One rejection edits the signals that caused
    // it and leaves kinds and areas alone.
    const drift = deviations(model)
    expect(drift.kinds).toEqual([])
    expect(drift.areas).toEqual([])
    expect(drift.signals.map((s) => s.id).sort()).toEqual([...drivers].sort())
  })

  it('does not let repeated rejections drive a signal to zero', () => {
    // A model that can be destroyed by one bad afternoon is not correctable,
    // it is fragile. Multipliers are clamped.
    let model = emptyModel()
    const target = build().cases.find((k) => k.provenance.source === 'model' && k.signals.length > 0)
    if (!target) return

    for (let round = 0; round < 25; round++) {
      model = applyFeedback({
        model,
        target: { ...targetOf(target), id: 'case-' + round },
        verdict: 'reject',
        reason: 'wrong_situation',
        now: builtAt(),
      }).model
    }

    for (const value of Object.values(model.signalTrust)) {
      expect(value).toBeGreaterThanOrEqual(0.1)
    }
    // And the docket still builds rather than collapsing to nothing.
    expect(build(model).cases.length).toBeGreaterThan(0)
  })

  it('treats approval as weaker evidence than rejection', () => {
    /**
     * Deliberate asymmetry. A maintainer approving a card may simply be
     * clearing a queue; a maintainer stopping to say "this is wrong" has spent
     * real attention. The nudge up is much smaller than the shove down.
     */
    const target = build().cases.find((k) => k.provenance.source === 'model' && k.signals.length > 0)
    if (!target) return

    const approved = applyFeedback({
      model: emptyModel(),
      target: targetOf(target),
      verdict: 'approve',
      now: builtAt(),
    }).model
    const rejected = applyFeedback({
      model: emptyModel(),
      target: targetOf(target),
      verdict: 'reject',
      reason: 'wrong_situation',
      now: builtAt(),
    }).model

    const signalId = targetOf(target).drivers[0] as string
    const up = (approved.signalTrust[signalId] ?? 1) - 1
    const down = 1 - (rejected.signalTrust[signalId] ?? 1)
    expect(up).toBeGreaterThan(0)
    expect(down).toBeGreaterThan(up * 3)
  })
})

describe('failure A on a rule-driven card', () => {
  it('never records a correction that changes nothing', () => {
    // The first card in the live demo is a rule-driven sweep. Rejecting it as
    // misread used to report "distrusted 0 signals" and leave the model as it was.
    const rule = build().cases.find((kase) => kase.provenance.source === 'rule')
    expect(rule).toBeDefined()
    if (!rule) return

    const { model, event, summary } = applyFeedback({
      model: emptyModel(),
      target: { ...targetOf(rule), drivers: ['rule.lines_behind', 'sweep.size'] },
      verdict: 'reject',
      reason: 'wrong_situation',
      now: builtAt(),
    })

    expect(event.adjustments.length).toBeGreaterThan(0)
    expect(model.kindInterest[rule.kind]).toBeLessThan(1)
    expect(summary.join(' ')).toContain('stated rule')
    expect(summary.join(' ')).not.toContain('0 signal')
  })
})
