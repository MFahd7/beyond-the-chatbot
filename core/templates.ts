/**
 * Read the repo's bug template back out of a filled-in issue body.
 *
 * Every heading and field name below was taken from the corpus rather than
 * from the template source, by counting which headings actually appear in
 * 2,000 real reports. That matters because two template generations are in
 * circulation and roughly a third of reports use neither:
 *
 *   current  "Link to the code that reproduces this issue" + "Current vs.
 *            Expected behavior" + "Which area(s) are affected?"
 *   legacy   "Describe the Bug" + "Expected Behavior" + "To Reproduce"
 *   none     free-form prose
 *
 * Telling these apart is load-bearing. A legacy report has no reproduction
 * field at all, so scoring it as "reproduction missing" would be measuring the
 * template's age instead of the reporter's effort -- and since template
 * generation correlates with the calendar, that mistake quietly turns the
 * whole model into a date detector. `reproFieldPresent` exists to keep
 * "left the field blank" and "was never asked" apart.
 */

import type { TemplateFields } from './types'
import { prose } from './text'

/** The repo's real area labels, as they appear in its label taxonomy. */
export const AREA_LABELS = [
  'adapters',
  'Cache Components',
  'Connection',
  'Cookies',
  'create-next-app',
  'CSS',
  'Documentation',
  'Draft Mode',
  'Dynamic Routes',
  'Error Handling',
  'Error Overlay',
  'examples',
  'Font (next/font)',
  'Form (next/form)',
  'Headers',
  'Image (next/image)',
  'Instrumentation',
  'Internationalization (i18n)',
  'Lazy Loading',
  'Linking and Navigating',
  'Linting',
  'Loading UI and Streaming',
  'Markdown (MDX)',
  'Metadata',
  'Middleware',
  'Module Resolution',
  'Not Found',
  'Output',
  'Pages Router',
  'Parallel & Intercepting Routes',
  'Performance',
  'React',
  'Redirects',
  'Root params',
  'Route Groups',
  'Route Handlers',
  'Rspack',
  'Runtime',
  'Script (next/script)',
  'Server Actions',
  'SWC',
  'Testing',
  'Turbopack',
  'TypeScript',
  'Upstream',
  'Webpack',
] as const

/**
 * The area options the *template* offers, which are not the same strings as
 * the repo's labels and must not be confused with them.
 *
 * Counted from the corpus: 880 of 1,000 open issues answer the area question,
 * using 123 distinct strings across several template generations. Some map
 * cleanly onto a label ("Turbopack"), some have no label at all ("App Router",
 * "Developer Experience"), and some are multi-word options containing commas
 * ("Routing (next/router, next/navigation, next/link)") -- which is why the
 * answer is matched by substring rather than split on commas, a mistake that
 * silently produces areas called "Routing (next/router".
 *
 * The distinction matters at the point of action: a declared area is good
 * enough to group a sweep by, but only a real label can be applied to an
 * issue. `TemplateFields.areas` holds the appliable ones and
 * `TemplateFields.declared` holds what the reporter actually ticked.
 */
export const TEMPLATE_AREAS = [
  'Turbopack',
  'Webpack',
  'Runtime',
  'Middleware',
  'Dynamic Routes',
  'App Router',
  'Pages Router',
  'Linking and Navigating',
  'Navigation',
  'Performance',
  'Output',
  'Server Actions',
  'cacheComponents',
  'Use Cache',
  'TypeScript',
  'Module Resolution',
  'Metadata',
  'Partial Prerendering (PPR)',
  'Parallel & Intercepting Routes',
  'CSS',
  'SWC',
  'Developer Experience',
  'Route Handlers',
  'Route Groups',
  'Image',
  'Font',
  'Script',
  'create-next-app',
  'Redirects',
  'Error Handling',
  'Error Overlay',
  'Internationalization (i18n)',
  'Lazy Loading',
  'Not Found',
  'Headers',
  'Cookies',
  'React',
  'Instrumentation',
  'Linting',
  'Loading UI and Streaming',
  'Markdown (MDX)',
  'Testing',
  'Draft Mode',
  'Documentation',
] as const

/**
 * The reporter ticked "Not sure". Worth its own signal: 104 of the 880 issues
 * that answer the question say they cannot localise their own bug, and that is
 * a real piece of information about how much triage the report still needs.
 */
const UNSURE = /not sure|leave empty if unsure|unsure/i

/**
 * Which team owns which area, for the routing action. Taken from the repo's
 * own `linear:` labels, which only distinguish the Turbopack team from the
 * rest of Next.js.
 */
const TURBOPACK_AREAS = new Set(['Turbopack', 'Webpack', 'SWC', 'Module Resolution', 'Rspack'])

export function teamFor(areas: string[]): 'turbopack' | 'next' {
  return areas.some((a) => TURBOPACK_AREAS.has(a)) ? 'turbopack' : 'next'
}

/** GitHub's form renderer writes this into any section left empty. */
const NO_RESPONSE = /^_no response_$/i

/**
 * The reproduction link the template itself suggests. Pasting it back
 * unchanged is the single most on-the-nose way to file a report with no
 * reproduction, and the maintainers catch it by hand today.
 */
const PLACEHOLDER_REPRO =
  /examples\/reproduction-template|vercel\/next\.js\/tree\/canary\/examples|codesandbox\.io\/p\/sandbox\/github\/vercel\/next\.js/i

const SANDBOX_HOSTS = /codesandbox\.io|stackblitz\.com|replit\.com|codepen\.io|gitpod\.io/i
const GITHUB_REPO_URL = /github\.com\/[\w.-]+\/[\w.-]+/i

/**
 * Pull the text under one heading, stopping at the next heading.
 *
 * Written imperatively after the regex version failed silently for months'
 * worth of corpus. The terminator was `(?=\n#{1,6}\s|$)` on an `im` pattern,
 * and under the `m` flag `$` matches the end of *every* line -- so the lazy
 * capture group ended immediately, every section came back empty, and
 * `area.declared` was a dead feature in a fitted model that reported
 * respectable numbers anyway. Finding the next heading by index cannot fail
 * that way.
 */
function section(body: string, ...titles: string[]): string | null {
  for (const title of titles) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const heading = new RegExp('^#{1,6}[ \\t]*' + escaped + '[^\\n]*$', 'im')
    const match = heading.exec(body)
    if (!match) continue

    const from = match.index + match[0].length
    const rest = body.slice(from)
    const next = rest.search(/\n#{1,6}[ \t]*\S/)
    const text = (next === -1 ? rest : rest.slice(0, next)).trim()
    if (text.length > 0) return text
  }
  return null
}

function hasHeading(body: string, ...titles: string[]): boolean {
  return titles.some((title) => {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp('^#{1,6}\\s*' + escaped, 'im').test(body)
  })
}

/**
 * Sortable version number. Canary and other prereleases sort just below the
 * stable release of the same number, which is what "is this reporter ahead of
 * or behind the release line" needs.
 */
export function versionOrder(version: string): number | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  const prerelease = /-(canary|rc|alpha|beta)/i.test(version) ? 0 : 1
  return major * 1_000_000 + minor * 1_000 + patch * 2 + prerelease
}

function extractVersion(body: string): string | null {
  // The `next info` dump is the reliable source: a "next: x.y.z" line inside
  // the environment block.
  const fromInfo = body.match(/^\s*next:\s*([0-9]+\.[0-9]+\.[0-9]+[^\s`]*)/im)
  if (fromInfo?.[1]) return fromInfo[1]

  // Legacy template asked in prose.
  const asked = section(body, 'What version of Next.js are you using?')
  if (asked) {
    const match = asked.match(/([0-9]+\.[0-9]+\.[0-9]+[^\s`,)]*)/)
    if (match?.[1]) return match[1]
  }

  // Last resort: any version-looking token near the word next.
  const loose = body.match(/next(?:\.js)?[@\s v]*([0-9]+\.[0-9]+\.[0-9]+[^\s`,)]*)/i)
  return loose?.[1] ?? null
}

function areaSection(body: string): string {
  return (
    section(
      body,
      'Which area(s) are affected? (Select all that apply)',
      'Which area(s) are affected?',
      'Which area(s) of Next.js are affected? (leave empty if unsure)',
      'Which area(s) of Next.js are affected?',
    ) ?? ''
  )
}

/** Areas that exist as labels, so they can actually be applied to the issue. */
function extractAreas(body: string): string[] {
  const text = areaSection(body)
  if (!text || NO_RESPONSE.test(text.trim())) return []

  const found: string[] = []
  const haystack = text.toLowerCase()
  for (const label of AREA_LABELS) {
    // Match the distinctive part: "Image (next/image)" comes back as "Image",
    // "next/image" or the full label depending on the reporter.
    const core = label.replace(/\s*\([^)]*\)\s*/g, '').trim()
    const paren = label.match(/\(([^)]+)\)/)?.[1]
    const candidates = [label, core, paren].filter(
      (c): c is string => typeof c === 'string' && c.length > 2,
    )
    if (candidates.some((c) => haystack.includes(c.toLowerCase()))) found.push(label)
  }
  return found
}

/** What the reporter actually ticked, label or not. Used to group sweeps. */
function extractDeclared(body: string): string[] {
  const text = areaSection(body)
  if (!text || NO_RESPONSE.test(text.trim())) return []
  const haystack = text.toLowerCase()
  const found: string[] = []
  for (const area of TEMPLATE_AREAS) {
    if (haystack.includes(area.toLowerCase())) found.push(area)
  }
  return found
}

function extractStages(body: string): string[] {
  const text =
    section(
      body,
      'Which stage(s) are affected? (Select all that apply)',
      'Which stage(s) are affected?',
    ) ?? ''
  if (!text || NO_RESPONSE.test(text.trim())) return []
  const stages: string[] = []
  for (const stage of ['next dev', 'next build', 'next start', 'Vercel', 'Other']) {
    if (text.toLowerCase().includes(stage.toLowerCase())) stages.push(stage)
  }
  return stages
}

function extractRepro(body: string): { url: string | null; fieldPresent: boolean; placeholder: boolean } {
  const fieldPresent = hasHeading(
    body,
    'Link to the code that reproduces this issue or a replay of the bug',
    'Link to the code that reproduces this issue',
    'Link to reproduction',
  )
  const text =
    section(
      body,
      'Link to the code that reproduces this issue or a replay of the bug',
      'Link to the code that reproduces this issue',
      'Link to reproduction',
    ) ?? ''

  const scope = text && !NO_RESPONSE.test(text.trim()) ? text : ''
  const url = scope.match(/https?:\/\/\S+/)?.[0] ?? null
  const placeholder = url ? PLACEHOLDER_REPRO.test(url) : false
  return { url, fieldPresent, placeholder }
}

export function parseTemplate(body: string): TemplateFields {
  const raw = body ?? ''

  const isCurrent = hasHeading(
    raw,
    'Link to the code that reproduces this issue or a replay of the bug',
    'Link to the code that reproduces this issue',
    'Which area(s) are affected? (Select all that apply)',
  )
  const isLegacy =
    !isCurrent && hasHeading(raw, 'Describe the Bug', 'To Reproduce', 'Expected Behavior')

  const repro = extractRepro(raw)
  const version = extractVersion(raw)
  const areas = extractAreas(raw)
  const declared = extractDeclared(raw)
  const areaText = areaSection(raw)

  const reproKind: TemplateFields['reproKind'] = !repro.url
    ? 'none'
    : repro.placeholder
      ? 'private'
      : SANDBOX_HOSTS.test(repro.url)
        ? 'sandbox'
        : GITHUB_REPO_URL.test(repro.url)
          ? 'github'
          : 'private'

  const steps =
    section(raw, 'To Reproduce', 'Steps to reproduce') ??
    section(raw, 'Current vs. Expected behavior', 'Current vs Expected behavior') ??
    ''

  return {
    templateUsed: isCurrent || isLegacy,
    reproUrl: repro.url,
    reproKind,
    nextVersion: version,
    nextVersionOrder: version ? versionOrder(version) : null,
    onCanary: version ? /-(canary|rc|alpha|beta)/i.test(version) : false,
    nodeVersion: raw.match(/^\s*Node:\s*([0-9]+\.[0-9]+\.[0-9]+)/im)?.[1] ?? null,
    os: raw.match(/^\s*Platform:\s*(\w+)/im)?.[1] ?? null,
    areas,
    declared,
    areaUnsure: Boolean(areaText) && UNSURE.test(areaText),
    stages: extractStages(raw),
    hasStackTrace: /^\s*at\s+\S+\s*\(/m.test(raw) || /\b[A-Z]\w*Error\b/.test(raw),
    // A numbered list is what "steps to reproduce" looks like when it is real.
    hasSteps: /^\s*\d+[.)]\s+\S/m.test(steps) || steps.split('\n').filter((l) => l.trim()).length >= 3,
    hasExpectedVsActual:
      /expected/i.test(raw) && /(current|actual)/i.test(raw) && prose(raw).length > 120,
    proseLength: prose(raw).length,
  }
}

/** Extra structural facts the signal layer wants but that are not template fields. */
export interface TemplateExtras {
  reproFieldPresent: boolean
  reproIsPlaceholder: boolean
  generation: 'current' | 'legacy' | 'none'
  blankSections: number
  canaryBoxTicked: boolean
}

export function parseExtras(body: string): TemplateExtras {
  const raw = body ?? ''
  const repro = extractRepro(raw)
  const isCurrent = hasHeading(
    raw,
    'Link to the code that reproduces this issue or a replay of the bug',
    'Link to the code that reproduces this issue',
    'Which area(s) are affected? (Select all that apply)',
  )
  const isLegacy =
    !isCurrent && hasHeading(raw, 'Describe the Bug', 'To Reproduce', 'Expected Behavior')

  return {
    reproFieldPresent: repro.fieldPresent,
    reproIsPlaceholder: repro.placeholder,
    generation: isCurrent ? 'current' : isLegacy ? 'legacy' : 'none',
    blankSections: (raw.match(/_No response_/gi) ?? []).length,
    canaryBoxTicked: /^\s*[-*]?\s*\[[xX]\][^\n]*canary/im.test(raw),
  }
}
