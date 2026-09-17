/**
 * FAILURE B -- the interface is right, and it is still the wrong thing to show.
 *
 * This is the failure mode that a confidence score cannot catch, and the
 * reason a single thumbs-down button is not enough. In all three cases below
 * the system's reading of the issue is correct; what is wrong is that it is
 * being shown to this person, now.
 *
 *   not_my_area      The decision is sound. It is somebody else's code.
 *   wrong_priority   The decision is sound. It is not what today is for.
 *   stale_evidence   The decision is sound on facts that have since expired.
 *
 * Each has to edit a different part of the model, and crucially none of them
 * may touch the reasoning. If "not my area" distrusted the signals that read
 * the issue correctly, the system would get worse at its job as a side effect
 * of learning who you are -- which is how personalisation quietly destroys a
 * model.
 *
 * The last test is the one that matters most: a demoted decision must be
 * *withheld with a reason*, never deleted. The operator has to be able to find
 * out why they stopped seeing something.
 */

import { describe, expect, it } from 'vitest'

import { buildDocket } from '@/core/docket'
import { applyFeedback, deviations, emptyModel, targetOf } from '@/core/operator'
import { builtAt, corpus, weights } from './support'

const build = (model = emptyModel()) =>
  buildDocket({ corpus: corpus(), weights: weights(), model, now: builtAt() })

describe('failure B: right call, wrong moment', () => {
  it('"not my area" demotes the area and leaves the reasoning intact', () => {
    const before = build()
    const target = before.cases.find((kase) =>
      kase.issues.some((issue) => issue.labels.length > 0),
    )
    expect(target, 'expected a case whose issues carry labels').toBeDefined()
    if (!target) return

    const areas = targetOf(target).areas
    expect(areas.length).toBeGreaterThan(0)

    const { model, summary } = applyFeedback({
      model: emptyModel(),
      target: targetOf(target),
      verdict: 'reject',
      reason: 'not_my_area',
      now: builtAt(),
    })

    const drift = deviations(model)
    // Areas moved.
    expect(drift.areas.length).toBeGreaterThan(0)
    for (const area of drift.areas) expect(area.value).toBeLessThan(1)
    // The reading did not.
    expect(drift.signals).toEqual([])
    expect(drift.kinds).toEqual([])
    expect(summary.join(' ')).toContain('reasoning was left alone')
  })

  it('"wrong priority" demotes the kind without distrusting any signal', () => {
    const target = build().cases[0]
    expect(target).toBeDefined()
    if (!target) return

    const { model } = applyFeedback({
      model: emptyModel(),
      target: targetOf(target),
      verdict: 'reject',
      reason: 'wrong_priority',
      now: builtAt(),
    })

    const drift = deviations(model)
    expect(drift.kinds.length).toBe(1)
    expect(drift.kinds[0]?.id).toBe(target.kind)
    expect(drift.kinds[0]?.value).toBeLessThan(1)
    expect(drift.signals).toEqual([])
  })

  it('"wrong priority" demotes less harshly than "wrong action"', () => {
    // "Not now" and "never do this" are different statements, and collapsing
    // them is how an interface stops being able to tell a busy operator from a
    // dissatisfied one.
    const target = build().cases[0]
    if (!target) return

    const notNow = applyFeedback({
      model: emptyModel(),
      target: targetOf(target),
      verdict: 'reject',
      reason: 'wrong_priority',
      now: builtAt(),
    }).model
    const never = applyFeedback({
      model: emptyModel(),
      target: targetOf(target),
      verdict: 'reject',
      reason: 'wrong_action',
      now: builtAt(),
    }).model

    expect(notNow.kindInterest[target.kind]).toBeGreaterThan(
      never.kindInterest[target.kind] as number,
    )
  })

  it('"stale evidence" distrusts only the time-based signals', () => {
    const target = build().cases.find((kase) => kase.signals.some((s) => s.kind === 'temporal'))
    if (!target) return

    const temporal = targetOf(target).temporal
    const { model } = applyFeedback({
      model: emptyModel(),
      target: targetOf(target),
      verdict: 'reject',
      reason: 'stale_evidence',
      now: builtAt(),
    })

    const drift = deviations(model)
    expect(drift.signals.map((s) => s.id).sort()).toEqual([...temporal].sort())
    expect(drift.kinds).toEqual([])
  })

  it('withholds a demoted kind with a reason instead of deleting it', () => {
    /**
     * The most important property in this file. Demotion must remain
     * inspectable: an operator who taught the system to stop showing them
     * something has to be able to find out what that was and undo it, or the
     * interface has just quietly lost part of the backlog.
     */
    let model = emptyModel()

    // Pick the kind with the most cases. Rejecting settles each case it is
    // shown, so a kind with only one instance would be exhausted before the
    // demotion could be observed on a survivor.
    const counts = new Map<string, number>()
    for (const kase of build().cases) counts.set(kase.kind, (counts.get(kase.kind) ?? 0) + 1)
    const kind = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    expect(kind).toBeDefined()
    if (!kind) return
    expect(counts.get(kind)).toBeGreaterThan(3)

    // Reject the same kind until it drops below the visibility threshold.
    for (let round = 0; round < 3; round++) {
      const docket = build(model)
      const next = docket.cases.find((c) => c.kind === kind)
      if (!next) break
      model = applyFeedback({
        model,
        target: targetOf(next),
        verdict: 'reject',
        reason: 'wrong_action',
        now: builtAt(),
      }).model
    }

    expect(model.kindInterest[kind]).toBeLessThan(0.5)

    const after = build(model)
    // Nothing of that kind is in the docket any more.
    expect(after.cases.filter((c) => c.kind === kind)).toEqual([])
    // And every one of them is listed as withheld, naming the operator's own
    // correction as the cause.
    const withheld = after.suppressed.filter((s) => s.kind === kind)
    expect(withheld.length).toBeGreaterThan(0)
    expect(
      withheld.some((s) => s.why.includes('you demoted')),
      'expected at least one item withheld because the operator demoted the kind',
    ).toBe(true)

    // The backlog is still whole.
    const covered = new Set(after.cases.flatMap((c) => c.issues.map((i) => i.number)))
    const hidden = new Set(after.suppressed.flatMap((s) => s.issues))
    const settled = new Set(model.settled)
    const accountedFor = new Set([...covered, ...hidden])
    for (const issue of corpus().open) {
      const inCase = accountedFor.has(issue.number)
      const wasSettled = [...settled].some((id) => id.includes(String(issue.number)))
      expect(inCase || wasSettled, '#' + issue.number + ' vanished').toBe(true)
    }
  })

  it('a deferral changes nothing about the model', () => {
    const target = build().cases[0]
    if (!target) return

    const { model, summary } = applyFeedback({
      model: emptyModel(),
      target: targetOf(target),
      verdict: 'snooze',
      now: builtAt(),
    })

    const drift = deviations(model)
    expect(drift.signals).toEqual([])
    expect(drift.kinds).toEqual([])
    expect(drift.areas).toEqual([])
    expect(model.snoozed[target.id]).toBeDefined()
    expect(summary.join(' ')).toContain('Nothing about the model changed')

    // It is withheld, with the date it returns.
    const after = build(model)
    expect(after.cases.find((c) => c.id === target.id)).toBeUndefined()
    expect(after.suppressed.find((s) => s.id === target.id)?.why).toContain('snoozed until')
  })
})
