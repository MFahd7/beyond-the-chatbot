/**
 * The parsing layer, including regression tests for two bugs that were silent.
 *
 * Both are worth a permanent test because neither threw, neither showed up in
 * a typecheck, and both produced plausible-looking output while destroying a
 * feature. A parser that fails loudly is a nuisance; one that fails quietly
 * invalidates everything downstream of it.
 */

import { describe, expect, it } from 'vitest'

import { cosine, buildIndex, jaccard, prose, stripMarkup, tokenize, trigrams } from '@/core/text'
import { parseExtras, parseTemplate, teamFor } from '@/core/templates'
import { corpus, report } from './support'

describe('section parsing', () => {
  /**
   * The bug: the section regex ended with `(?=\n#{1,6}\s|$)` under the `m`
   * flag, where `$` matches the end of every line -- so the lazy capture group
   * terminated at the first newline and every section came back empty. Areas
   * were unparsed for the entire corpus, `area.declared` was a dead feature,
   * and the fitted models still reported respectable numbers. Fixing it moved
   * needs_repro from AUC 0.71 to 0.77 and stale_close from 0.59 to 0.66.
   */
  it('reads a multi-line section rather than stopping at the first newline', () => {
    const template = parseTemplate(
      report({ areas: 'Turbopack, Output (export/standalone), Module Resolution' }),
    )
    expect(template.areas).toContain('Turbopack')
    expect(template.areas).toContain('Module Resolution')
    expect(template.areas.length).toBeGreaterThan(1)
  })

  it('does not split area answers on commas inside an option name', () => {
    // "Routing (next/router, next/navigation, next/link)" is ONE option.
    // Splitting on commas invents an area called "Routing (next/router".
    const template = parseTemplate(
      report({ areas: 'Routing (next/router, next/navigation, next/link)' }),
    )
    for (const area of template.declared) {
      expect(area).not.toContain('(next/router')
      expect(area.split('(').length - 1).toBeLessThanOrEqual(1)
    }
  })

  it('separates areas that exist as labels from areas that do not', () => {
    // "App Router" is a template option with no matching label. Applying it
    // would produce a request GitHub rejects.
    const template = parseTemplate(report({ areas: 'App Router, Turbopack' }))
    expect(template.declared).toContain('App Router')
    expect(template.areas).toContain('Turbopack')
    expect(template.areas).not.toContain('App Router')
  })

  it('records when the reporter cannot localise their own bug', () => {
    expect(parseTemplate(report({ areas: 'Not sure' })).areaUnsure).toBe(true)
    expect(parseTemplate(report({ areas: 'Turbopack' })).areaUnsure).toBe(false)
  })
})

describe('reproduction detection', () => {
  it('tells a blank field apart from a template that never asked', () => {
    const current = parseExtras(report({}))
    expect(current.reproFieldPresent).toBe(true)
    expect(current.generation).toBe('current')

    const legacy = parseExtras(
      ['### Describe the Bug', '', 'It breaks.', '', '### Expected Behavior', '', 'No break.'].join(
        '\n',
      ),
    )
    expect(legacy.reproFieldPresent).toBe(false)
    expect(legacy.generation).toBe('legacy')
  })

  it("catches the template's own example pasted back unchanged", () => {
    // The sharpest real signal in the corpus, and one maintainers catch by
    // hand: a reproduction link that is the placeholder from the template.
    const extras = parseExtras(
      report({
        repro:
          'https://codesandbox.io/p/sandbox/github/vercel/next.js/tree/canary/examples/reproduction-template',
      }),
    )
    expect(extras.reproIsPlaceholder).toBe(true)
    expect(parseTemplate(report({ repro: 'https://github.com/me/real-repro' })).reproKind).toBe(
      'github',
    )
  })

  it('reads the environment block', () => {
    const template = parseTemplate(report({ version: '15.4.2' }))
    expect(template.nextVersion).toBe('15.4.2')
    expect(template.nodeVersion).toBe('20.11.0')
    expect(template.os).toBe('linux')
    expect(template.onCanary).toBe(false)
    expect(parseTemplate(report({ version: '16.0.0-canary.31' })).onCanary).toBe(true)
  })
})

describe('text normalisation', () => {
  /**
   * The bug: two unrelated reports scored 0.45 cosine against each other
   * because both pasted a screenshot, and GitHub expands a pasted screenshot
   * into an <img width alt src height> tag. Every report with an image was
   * drifting toward every other report with an image.
   */
  it('strips attachment markup so screenshots do not make issues look alike', () => {
    const withImage =
      'The build fails.\n\n<img width="1024" alt="screenshot" src="https://user-images/x.png" height="768">'
    expect(stripMarkup(withImage)).not.toContain('img')
    expect(prose(withImage)).not.toContain('width')
    expect(prose(withImage)).toContain('build fails')
  })

  it('drops template scaffolding and code from the prose', () => {
    const text = prose(report({ version: '15.0.0' }))
    expect(text).not.toContain('Provide environment information')
    expect(text).not.toContain('Node: 20.11.0')
    expect(text).toContain('should not throw')
  })

  it('discards boilerplate tokens that carry no discriminating power', () => {
    const tokens = tokenize('The issue is that the reproduction link version is broken')
    expect(tokens).not.toContain('issue')
    expect(tokens).not.toContain('reproduction')
    expect(tokens).toContain('broken')
  })

  it('scores an identical document at cosine 1 and disjoint ones at 0', () => {
    const index = buildIndex(
      [
        { id: 1, text: 'turbopack module resolution fails on windows symlink' },
        { id: 2, text: 'turbopack module resolution fails on windows symlink' },
        { id: 3, text: 'metadata generation duplicates opengraph tags' },
        { id: 4, text: 'metadata generation duplicates opengraph tags' },
      ],
      { minDf: 1, maxDfRatio: 1 },
    )
    const v = (id: number) => index.vectors.get(id)!
    expect(cosine(v(1), v(2))).toBeCloseTo(1, 5)
    expect(cosine(v(1), v(3))).toBeCloseTo(0, 5)
  })

  it('matches near-identical titles on trigrams where tokens diverge', () => {
    const a = trigrams("TypeError: Cannot read properties of undefined (reading 'call')")
    const b = trigrams("[NextJS 14.1.0] TypeError: Cannot read properties of undefined (reading 'call')")
    expect(jaccard(a, b)).toBeGreaterThan(0.7)
  })
})

describe('team routing', () => {
  it('sends compiler areas to turbopack and everything else to next', () => {
    expect(teamFor(['Turbopack'])).toBe('turbopack')
    expect(teamFor(['Module Resolution'])).toBe('turbopack')
    expect(teamFor(['Metadata'])).toBe('next')
    expect(teamFor([])).toBe('next')
  })
})

describe('the committed corpus is real', () => {
  it('carries real issue numbers and real github urls', () => {
    const data = corpus()
    expect(data.meta.repo).toBe('vercel/next.js')
    expect(data.open.length).toBeGreaterThan(900)

    for (const issue of data.open.slice(0, 50)) {
      expect(issue.url).toBe('https://github.com/vercel/next.js/issues/' + issue.number)
      expect(issue.number).toBeGreaterThan(0)
      expect(issue.state).toBe('open')
      expect(issue.title.length).toBeGreaterThan(0)
    }
  })

  it('parsed the template for most of the backlog', () => {
    const data = corpus()
    const withArea = data.open.filter((i) => data.templates[i.number]?.declared.length).length
    const withVersion = data.open.filter((i) => data.templates[i.number]?.nextVersion).length
    // Measured: 746 of 1,000 declare an area, 868 report a version.
    expect(withArea).toBeGreaterThan(600)
    expect(withVersion).toBeGreaterThan(700)
  })
})
