/**
 * Turn the raw API pages into the two artefacts the rest of the project reads:
 *
 *   data/corpus.json     the open backlog, parsed, signalled and clustered.
 *                        Committed, so a clean clone runs with no network.
 *   data/features.json   feature vectors and labels for the fitter. Numbers
 *                        only, no issue bodies, so it stays small enough to
 *                        commit -- which means `npm run data:fit` reproduces
 *                        the published weights offline.
 *
 * The important property: feature extraction happens exactly once, here, using
 * the same core/signals.ts the server uses at request time. If the fitter had
 * its own copy of the parsing logic, the weights would be fitted against
 * features that differ subtly from the ones they are later applied to, and
 * every number in data/eval.json would be describing a model that does not
 * exist. Sharing the code is the only way to keep train and serve honest.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { buildIndex, prose } from '../core/text'
import { parseExtras, parseTemplate } from '../core/templates'
import { buildVersionTimeline, extractSignals, featureVector } from '../core/signals'
import { findClusters } from '../core/cluster'
import type { Corpus, Issue, Signal, TemplateFields } from '../core/types'

const DATA = path.join(process.cwd(), 'data')
const RAW = path.join(DATA, 'raw')

interface RawIssue {
  number: number
  title: string
  body: string | null
  state: string
  state_reason: string | null
  labels: string[]
  created_at: string
  updated_at: string
  closed_at: string | null
  comments: number
  reactions: number
  author: string | null
  author_association: string | null
  assignees: string[]
  milestone: string | null
  locked: boolean
  html_url: string
}

function normalise(raw: RawIssue): Issue {
  return {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    stateReason: raw.state_reason ?? null,
    labels: raw.labels ?? [],
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at ?? null,
    comments: raw.comments ?? 0,
    reactions: raw.reactions ?? 0,
    author: raw.author ?? null,
    authorAssociation: raw.author_association ?? null,
    assignees: raw.assignees ?? [],
    milestone: raw.milestone ?? null,
    locked: Boolean(raw.locked),
    url: raw.html_url,
  }
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(RAW, name), 'utf8')) as T
}

/** Labelled example, as the fitter wants it: numbers, a class, and a year. */
interface FeatureRow {
  number: number
  year: string
  /** The triage label the maintainers applied, if this row has one. */
  action: string | null
  /** completed | not_planned, the era-stable resolution. */
  resolution: string | null
  features: number[]
}

async function main() {
  console.log('Reading data/raw ...')
  const [rawOpen, rawTraining, rawEras, manifest] = await Promise.all([
    readJson<RawIssue[]>('open.json'),
    readJson<Record<string, RawIssue[]>>('training.json'),
    readJson<Record<string, RawIssue[]>>('eras.json'),
    readJson<{
      repo: string
      fetched_at: string
      open_count: number
      open_total_reported: number
      classes: { id: string; means: string; query: string; fetched: number }[]
    }>('manifest.json'),
  ])

  const open = rawOpen.map(normalise)

  // Every issue in one list, deduplicated by number: the era pool and the
  // label pool overlap, and an issue must not contribute twice to the version
  // timeline or appear twice in the training set.
  const everything = new Map<number, { issue: Issue; action: string | null; resolution: string | null }>()
  for (const issue of open) everything.set(issue.number, { issue, action: null, resolution: null })

  for (const [action, items] of Object.entries(rawTraining)) {
    for (const raw of items) {
      const issue = normalise(raw)
      const existing = everything.get(issue.number)
      if (existing) existing.action = existing.action ?? action
      else everything.set(issue.number, { issue, action, resolution: null })
    }
  }

  for (const [key, items] of Object.entries(rawEras)) {
    const resolution = key.split(':')[0] ?? null
    for (const raw of items) {
      const issue = normalise(raw)
      const existing = everything.get(issue.number)
      if (existing) existing.resolution = existing.resolution ?? resolution
      else everything.set(issue.number, { issue, action: null, resolution })
    }
  }

  console.log(everything.size + ' distinct issues (' + open.length + ' of them open)')

  // ------------------------------------------------------------------ parsing

  console.log('Parsing templates ...')
  const templates = new Map<number, TemplateFields>()
  const extras = new Map<number, ReturnType<typeof parseExtras>>()
  for (const { issue } of everything.values()) {
    templates.set(issue.number, parseTemplate(issue.body))
    extras.set(issue.number, parseExtras(issue.body))
  }

  const generations = { current: 0, legacy: 0, none: 0 }
  for (const e of extras.values()) generations[e.generation]++
  console.log(
    '  template generation: current ' +
      generations.current +
      ', legacy ' +
      generations.legacy +
      ', none ' +
      generations.none,
  )

  // The timeline is built from every issue, open and closed, because the more
  // reports there are for a version the better the estimate of when it shipped.
  console.log('Deriving the release line from reported versions ...')
  const timeline = buildVersionTimeline(
    [...everything.values()].map(({ issue }) => ({
      createdAt: issue.createdAt,
      template: templates.get(issue.number) as TemplateFields,
    })),
  )
  console.log('  ' + timeline.entries.length + ' versions with 3+ reports each')
  const newest = timeline.entries.at(-1)
  if (newest) console.log('  newest on the line: ' + newest.version)

  // ------------------------------------------------------------------ signals

  console.log('Extracting signals ...')
  const features: Record<number, Record<string, Signal>> = {}
  const rows: FeatureRow[] = []

  for (const { issue, action, resolution } of everything.values()) {
    const signals = extractSignals(
      issue,
      templates.get(issue.number) as TemplateFields,
      extras.get(issue.number) as ReturnType<typeof parseExtras>,
      timeline,
    )
    if (issue.state === 'open') features[issue.number] = signals
    if (action || resolution) {
      rows.push({
        number: issue.number,
        year: issue.createdAt.slice(0, 4),
        action,
        resolution,
        features: featureVector(signals).map((v) => Number(v.toFixed(4))),
      })
    }
  }
  console.log('  ' + rows.length + ' labelled rows for the fitter')

  // ----------------------------------------------------------------- clusters

  console.log('Indexing the open backlog ...')
  const index = buildIndex(
    open.map((issue) => ({
      id: issue.number,
      // Title counts twice: it is the part a reporter writes deliberately, and
      // duplicates tend to agree on it more than on the body.
      text: issue.title + ' ' + issue.title + ' ' + prose(issue.body),
    })),
  )
  console.log('  vocabulary: ' + index.vocabulary + ' terms over ' + index.documentCount + ' issues')

  console.log('Clustering duplicates ...')
  const { clusters, pairs, thresholds } = findClusters(open, index)
  const clustered = new Set(clusters.flatMap((c) => c.members))
  console.log(
    '  ' +
      clusters.length +
      ' clusters covering ' +
      clustered.size +
      ' issues (' +
      pairs.length +
      ' linking pairs)',
  )
  const sizes = new Map<number, number>()
  for (const c of clusters) sizes.set(c.members.length, (sizes.get(c.members.length) ?? 0) + 1)
  console.log(
    '  sizes: ' +
      [...sizes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([size, count]) => size + '×' + count)
        .join(', '),
  )

  // ------------------------------------------------------------------- output

  const corpus: Corpus = {
    meta: {
      repo: manifest.repo,
      fetchedAt: manifest.fetched_at,
      builtAt: new Date().toISOString(),
      openCount: open.length,
      openTotalReported: manifest.open_total_reported,
      trainingCount: rows.length,
      classes: manifest.classes,
      clusterCount: clusters.length,
      clusteredIssues: clustered.size,
      vocabulary: index.vocabulary,
      similarityThreshold: thresholds.cosineStrong,
    },
    open,
    templates: Object.fromEntries(
      open.map((i) => [i.number, templates.get(i.number) as TemplateFields]),
    ),
    extras: Object.fromEntries(
      open.map((i) => [i.number, extras.get(i.number) as ReturnType<typeof parseExtras>]),
    ),
    features,
    clusters,
    versions: timeline.entries,
  }

  await mkdir(DATA, { recursive: true })
  await writeFile(path.join(DATA, 'corpus.json'), JSON.stringify(corpus), 'utf8')
  await writeFile(
    path.join(DATA, 'features.json'),
    JSON.stringify({
      builtAt: corpus.meta.builtAt,
      repo: manifest.repo,
      rows,
    }),
    'utf8',
  )

  console.log('\nWrote data/corpus.json and data/features.json')
  console.log('Next: npm run data:fit')
}

main().catch((err) => {
  console.error('\nBuild failed: ' + (err instanceof Error ? err.stack : String(err)))
  process.exitCode = 1
})
