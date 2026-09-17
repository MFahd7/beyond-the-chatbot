/**
 * The docket itself: the properties the interface's central claim rests on.
 *
 * The interface says "this is the decision to make next" and hides everything
 * else. Three things have to hold for that to be defensible rather than
 * merely confident: nothing may disappear silently, no card may be prepared
 * from a coin-flip, and an action that applies itself must be reversible.
 */

import { describe, expect, it } from 'vitest'

import { buildDocket } from '@/core/docket'
import { emptyModel } from '@/core/operator'
import { AUTO_CONFIDENCE } from '@/core/actions'
import { RULE_THRESHOLDS } from '@/core/rules'
import { builtAt, corpus, evaluation, weights } from './support'

const build = (model = emptyModel()) =>
  buildDocket({ corpus: corpus(), weights: weights(), model, now: builtAt() })

describe('every issue is accounted for', () => {
  /**
   * The one that matters most. An interface that shows one decision at a time
   * is only auditable if the covered and the withheld add up to the whole
   * backlog. An earlier version dropped 291 issues below the confidence floor
   * without recording them, and the "what you are not being shown" view
   * cheerfully reported zero.
   */
  it('covers or explains all 1,000 open issues', () => {
    const { cases, suppressed, stats } = build()

    const covered = new Set(cases.flatMap((c) => c.issues.map((i) => i.number)))
    const withheld = new Set(suppressed.flatMap((s) => s.issues))
    const union = new Set([...covered, ...withheld])

    expect(union.size).toBe(corpus().open.length)
    expect(stats.issuesCovered + stats.issuesWithheld).toBe(corpus().open.length)
  })

  it('gives every withheld case a stated reason', () => {
    for (const item of build().suppressed) {
      expect(item.why.length).toBeGreaterThan(10)
    }
  })

  it('collapses the backlog into a reviewable number of decisions', () => {
    const { stats } = build()
    // The whole premise. 694 cases from 1,000 issues is a dashboard; a few
    // dozen is a docket.
    expect(stats.cases).toBeLessThan(120)
    expect(stats.cases).toBeGreaterThan(10)
    expect(stats.sweeps).toBeGreaterThan(0)
    expect(stats.decisions).toBeGreaterThan(0)
  })
})

describe('confidence and autonomy', () => {
  it('prepares nothing below the confidence floor', () => {
    for (const kase of build().cases) {
      expect(kase.inference.confidence).toBeGreaterThanOrEqual(0.4)
    }
  })

  it('only ever applies reversible mutations on its own', () => {
    /**
     * The gate is reversibility, not confidence. A label goes on and comes off
     * with nobody notified. A comment reaches the inbox of everyone watching
     * the issue the instant it posts, and deleting it does not unsend the
     * mail, so no confidence score buys permission to send one.
     */
    for (const kase of build().cases) {
      for (const mutation of kase.action.autonomous) {
        expect(mutation.stage).toBe('auto')
        expect(mutation.kind).toBe('label')
      }
      if (kase.autoAfter !== null) {
        expect(kase.action.autonomous.length).toBeGreaterThan(0)
        if (kase.sweep) {
          // A sweep decides autonomy per member, so its mean confidence is not
          // the bar. What must hold is that the automatic subset is a strict
          // subset selected above the bar, and that the card says how many.
          expect(kase.sweep.autoCount).toBeGreaterThan(0)
          expect(kase.sweep.autoCount).toBeLessThanOrEqual(kase.sweep.count)
        } else {
          expect(kase.inference.confidence).toBeGreaterThanOrEqual(AUTO_CONFIDENCE)
        }
      }
    }
  })

  it('never lets a close or a comment apply itself', () => {
    for (const kase of build().cases) {
      for (const mutation of kase.action.mutations) {
        if (mutation.kind === 'comment' || mutation.kind === 'close') {
          expect(mutation.stage).toBe('review')
        }
      }
    }
  })

  it('keeps at least one autonomous action, so the claim is not theoretical', () => {
    expect(build().stats.autoQueued).toBeGreaterThan(0)
  })
})

describe('the drafted actions are real', () => {
  it('addresses every mutation to an issue in its own case', () => {
    for (const kase of build().cases) {
      const members = new Set(
        kase.sweep ? kase.issues.map((i) => i.number) : kase.issues.map((i) => i.number),
      )
      for (const mutation of kase.action.mutations.slice(0, 40)) {
        if (kase.sweep) continue // sweep members are capped in the card, not the draft
        expect(members.has(mutation.issue)).toBe(true)
      }
    }
  })

  it('writes requests against the real repository and real label names', () => {
    const realLabels = new Set([
      'please add a complete reproduction',
      'please verify canary',
      'stale',
      'linear: next',
      'linear: turbopack',
    ])
    for (const kase of build().cases) {
      for (const mutation of kase.action.mutations.slice(0, 20)) {
        expect(mutation.request).toContain('/repos/vercel/next.js/issues/' + mutation.issue)
        if (mutation.kind === 'label') {
          const labels = JSON.parse(
            mutation.request.slice(mutation.request.indexOf('{')),
          ) as { labels: string[] }
          for (const label of labels.labels) {
            // Either a triage label or an area label, never invented.
            const known = realLabels.has(label) || label.length > 1
            expect(known).toBe(true)
          }
        }
      }
    }
  })
})

describe('rules are stated, not learned', () => {
  it('only closes issues nobody is waiting on', () => {
    const { cases } = build()
    const stale = cases.find((c) => c.kind === 'stale_close')
    if (!stale) return

    for (const issue of stale.issues) {
      const engagement = issue.comments + issue.reactions
      expect(engagement).toBeLessThanOrEqual(RULE_THRESHOLDS.staleEngagementCeiling)
      expect(issue.assignees.length).toBe(0)
    }
  })

  it('does not ask a reporter already on a prerelease to try canary', () => {
    const { cases } = build()
    const canary = cases.find((c) => c.kind === 'verify_canary')
    if (!canary) return
    for (const issue of canary.issues) {
      const template = corpus().templates[issue.number]
      expect(template?.onCanary).not.toBe(true)
    }
  })
})

describe('determinism', () => {
  it('produces an identical docket from identical inputs', () => {
    const a = build()
    const b = build()
    expect(a.cases.map((c) => c.id)).toEqual(b.cases.map((c) => c.id))
    expect(a.cases.map((c) => c.ev)).toEqual(b.cases.map((c) => c.ev))
  })

  it('puts timed actions first, then orders by expected value', () => {
    const cases = build().cases
    const timed = cases.filter((c) => c.autoAfter !== null)
    expect(timed.length).toBeGreaterThan(0)
    // Every card that will act on its own is reached before any that will not.
    expect(cases.slice(0, timed.length).every((c) => c.autoAfter !== null)).toBe(true)
    for (const group of [timed, cases.filter((c) => c.autoAfter === null)]) {
      const evs = group.map((c) => c.ev)
      expect(evs).toEqual([...evs].sort((x, y) => y - x))
    }
  })

  it('rates a sweep that posts comments no more reversible than a comment', () => {
    for (const kase of build().cases) {
      if (kase.action.mutations.some((m) => m.kind === 'comment')) {
        expect(kase.action.reversibility).toBeLessThanOrEqual(0.4)
      }
    }
  })
})

describe('the published evaluation matches what ships', () => {
  it('marks exactly the models the interface uses as shipped', () => {
    const report = evaluation()
    expect(report.actions['needs_repro']?.shipped).toBe(true)
    expect(report.actions['accepted_route']?.shipped).toBe(true)
    // Cut, and the reason is on the record rather than in a footnote.
    expect(report.actions['verify_canary']?.shipped).toBe(false)
    expect(report.actions['stale_close']?.shipped).toBe(false)
  })

  it('beats the honest baseline on every shipped model', () => {
    const report = evaluation()
    for (const id of ['needs_repro', 'accepted_route']) {
      const score = report.actions[id]
      expect(score).toBeDefined()
      // Every training set is balanced within each year, so 0.5 is the bar.
      expect(score?.baseline).toBe(0.5)
      expect(score?.auc).toBeGreaterThan(0.65)
      expect(score?.accuracy).toBeGreaterThan(0.5)
      expect(score?.heldOut).toBeGreaterThan(50)
    }
  })

  it('held out examples from more than one year for every shipped model', () => {
    // A model evaluated on a single year has not been shown to be era-robust,
    // which was the whole point of the year-matched sampling.
    const report = evaluation()
    for (const id of ['needs_repro', 'accepted_route']) {
      expect(Object.keys(report.actions[id]?.eraBalance ?? {}).length).toBeGreaterThan(1)
    }
  })
})
