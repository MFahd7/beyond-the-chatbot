/**
 * The no-leakage rule, enforced rather than promised.
 *
 * core/signals.ts claims every fitted feature describes the submission only,
 * and that nothing which accumulates after filing can reach the classifier.
 * That claim is the reason the held-out numbers in data/eval.json mean
 * anything, so it should not rest on whoever edits the file next remembering
 * the convention.
 *
 * The property tested here is stronger than a list of banned field names: take
 * a real issue, change every post-filing field on it -- comments, reactions,
 * labels, assignees, milestone, close reason, even the update timestamp -- and
 * the fitted feature vector must come back bit-identical. If a future feature
 * reads any of them, this fails immediately.
 */

import { describe, expect, it } from 'vitest'

import { FITTED_SIGNAL_IDS, buildVersionTimeline, extractSignals, featureVector } from '@/core/signals'
import { parseExtras, parseTemplate } from '@/core/templates'
import { corpus, issue, report } from './support'
import type { TemplateFields } from '@/core/types'

function vectorFor(source: ReturnType<typeof issue>) {
  const template = parseTemplate(source.body)
  const extras = parseExtras(source.body)
  const timeline = buildVersionTimeline(
    Object.entries(corpus().templates).map(([, t]) => ({
      createdAt: '2020-01-01T00:00:00Z',
      template: t as TemplateFields,
    })),
  )
  return featureVector(extractSignals(source, template, extras, timeline))
}

describe('fitted features cannot see anything that happened after filing', () => {
  it('ignores every post-filing field', () => {
    const body = report({ repro: 'https://github.com/someone/repro', version: '15.2.1' })

    const atFiling = issue({ body, comments: 0, reactions: 0, labels: [] })

    // The same report, after a maintainer triaged it: the label that IS the
    // training target, the comment they left asking for a reproduction, the
    // reactions it collected, an assignee, a milestone, and a close.
    const afterTriage = issue({
      body,
      comments: 14,
      reactions: 231,
      labels: ['please add a complete reproduction', 'Turbopack', 'linear: next', 'stale'],
      assignees: ['a-maintainer'],
      milestone: '16.1.0',
      state: 'closed',
      stateReason: 'not_planned',
      closedAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-01T00:00:00Z',
      locked: true,
    })

    expect(vectorFor(afterTriage)).toEqual(vectorFor(atFiling))
  })

  it('does react to the submission itself, so the test above is not vacuous', () => {
    const withRepro = issue({
      body: report({ repro: 'https://github.com/someone/repro' }),
    })
    const withoutRepro = issue({ body: report({}) })

    expect(vectorFor(withRepro)).not.toEqual(vectorFor(withoutRepro))
  })

  it('names no post-filing field among the fitted signal ids', () => {
    const banned = ['comment', 'reaction', 'assignee', 'milestone', 'label', 'age', 'idle', 'closed']
    for (const id of FITTED_SIGNAL_IDS) {
      for (const word of banned) {
        expect(id.includes(word), id + ' looks like it reads a post-filing field').toBe(false)
      }
    }
  })

  it('keeps the weights file in step with the feature list', () => {
    // Train/serve skew would make every published number describe a model that
    // does not exist. The contract is the signal id list.
    const fitted = new Set(FITTED_SIGNAL_IDS)
    const stored = Object.keys(
      JSON.parse(
        require('node:fs').readFileSync(
          require('node:path').join(process.cwd(), 'data', 'weights.json'),
          'utf8',
        ),
      ).resolution.weights,
    )
    expect(new Set(stored)).toEqual(fitted)
  })
})

describe('version lag is invariant to when the issue was filed', () => {
  /**
   * The confound that nearly sank the whole model: label usage is stratified
   * by era, so any feature that encodes "what year is this" lets the
   * classifier separate the classes without learning anything about bug
   * reports. Lag is measured against the release line current *at filing*, so
   * a reporter who was up to date in 2022 and one who is up to date now must
   * produce the same number.
   */
  it('scores two up-to-date reporters from different years identically', () => {
    const timeline = buildVersionTimeline([
      { createdAt: '2022-01-01T00:00:00Z', template: parseTemplate(report({ version: '12.0.0' })) },
      { createdAt: '2022-01-02T00:00:00Z', template: parseTemplate(report({ version: '12.0.1' })) },
      { createdAt: '2022-01-03T00:00:00Z', template: parseTemplate(report({ version: '12.0.2' })) },
      { createdAt: '2026-01-01T00:00:00Z', template: parseTemplate(report({ version: '16.0.0' })) },
      { createdAt: '2026-01-02T00:00:00Z', template: parseTemplate(report({ version: '16.0.1' })) },
      { createdAt: '2026-01-03T00:00:00Z', template: parseTemplate(report({ version: '16.0.2' })) },
    ])

    const old = issue({
      createdAt: '2022-01-10T00:00:00Z',
      body: report({ version: '12.0.0' }),
    })
    const recent = issue({
      createdAt: '2026-01-10T00:00:00Z',
      body: report({ version: '16.0.0' }),
    })

    const lagOf = (source: ReturnType<typeof issue>) =>
      extractSignals(source, parseTemplate(source.body), parseExtras(source.body), timeline)[
        'version.lag'
      ]?.value

    expect(lagOf(old)).toBe(lagOf(recent))
    expect(lagOf(old)).toBe(0)
  })

  it('counts release lines rather than subtracting version numbers', () => {
    // The original bug: ordering packed majors at 1e6 and minors at 1e3, so a
    // single major bump read as 1,000 minor versions and the feature saturated
    // to a near-binary flag while the evidence line claimed "999.9 versions
    // behind".
    const timeline = buildVersionTimeline(
      ['15.0.0', '15.1.0', '16.0.0', '16.1.0'].flatMap((version) =>
        [1, 2, 3].map((n) => ({
          createdAt: '2025-0' + n + '-01T00:00:00Z',
          template: parseTemplate(report({ version })),
        })),
      ),
    )

    const source = issue({ createdAt: '2026-01-01T00:00:00Z', body: report({ version: '15.0.0' }) })
    const signal = extractSignals(
      source,
      parseTemplate(source.body),
      parseExtras(source.body),
      timeline,
    )['version.lag']

    // Three lines shipped after 15.0: 15.1, 16.0, 16.1.
    expect(signal?.evidence).toContain('3 minor line')
    expect(signal?.value).toBeCloseTo(3 / 20, 5)
  })
})
