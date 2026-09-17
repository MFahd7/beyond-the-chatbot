/**
 * Where the duplicate-detection thresholds in core/cluster.ts come from.
 *
 * Kept in the repository because "cosine >= 0.62" is otherwise a magic number,
 * and the only way to defend it is to look at the pairs it accepts and the
 * pairs it turns away. Run it and read the two lists: the bar belongs wherever
 * real duplicates stop and coincidences start.
 *
 *   npx tsx scripts/tune-clusters.ts            top pairs + score distribution
 *   npx tsx scripts/tune-clusters.ts 0.5        also show what a 0.5 bar admits
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { buildIndex, cosine, jaccard, prose, sharedTerms, trigrams } from '../core/text'
import { findClusters } from '../core/cluster'
import type { Corpus } from '../core/types'

const corpus = JSON.parse(
  readFileSync(path.join(process.cwd(), 'data', 'corpus.json'), 'utf8'),
) as Corpus

const open = corpus.open
const index = buildIndex(
  open.map((i) => ({ id: i.number, text: i.title + ' ' + i.title + ' ' + prose(i.body) })),
)

const grams = new Map(open.map((i) => [i.number, trigrams(i.title)]))
const titles = new Map(open.map((i) => [i.number, i.title]))

interface Scored {
  a: number
  b: number
  c: number
  t: number
  terms: string[]
}

const pairs: Scored[] = []
for (let i = 0; i < open.length; i++) {
  for (let j = i + 1; j < open.length; j++) {
    const a = open[i]
    const b = open[j]
    if (!a || !b) continue
    const va = index.vectors.get(a.number)
    const vb = index.vectors.get(b.number)
    if (!va || !vb) continue
    const c = cosine(va, vb)
    const t = jaccard(grams.get(a.number) as Set<string>, grams.get(b.number) as Set<string>)
    if (c < 0.2 && t < 0.4) continue
    pairs.push({ a: a.number, b: b.number, c, t, terms: sharedTerms(va, vb, 5) })
  }
}

pairs.sort((x, y) => Math.max(y.c, y.t) - Math.max(x.c, x.t))

const buckets = new Map<string, number>()
for (const p of pairs) {
  const key = (Math.floor(p.c * 10) / 10).toFixed(1)
  buckets.set(key, (buckets.get(key) ?? 0) + 1)
}

console.log('Pairs scored: ' + pairs.length + ' of ' + (open.length * (open.length - 1)) / 2)
console.log(
  'cosine distribution: ' +
    [...buckets.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([k, v]) => k + ':' + v)
      .join('  '),
)
for (const bar of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
  console.log(
    '  cosine >= ' +
      bar.toFixed(2) +
      ': ' +
      pairs.filter((p) => p.c >= bar).length +
      ' pairs   |   trigram >= ' +
      bar.toFixed(2) +
      ': ' +
      pairs.filter((p) => p.t >= bar).length +
      ' pairs',
  )
}

const show = (list: Scored[], heading: string, limit: number) => {
  console.log('\n=== ' + heading + ' ===')
  for (const p of list.slice(0, limit)) {
    console.log(
      'cos=' + p.c.toFixed(3) + ' tri=' + p.t.toFixed(2) + '  shared: ' + p.terms.join(', '),
    )
    console.log('   #' + p.a + '  ' + (titles.get(p.a) ?? '').slice(0, 96))
    console.log('   #' + p.b + '  ' + (titles.get(p.b) ?? '').slice(0, 96))
  }
}

show(pairs, 'STRONGEST 30 PAIRS IN THE OPEN BACKLOG', 30)

const floor = Number(process.argv[2] ?? NaN)
if (!Number.isNaN(floor)) {
  const band = pairs.filter((p) => p.c >= floor && p.c < floor + 0.1)
  show(band, 'WHAT A ' + floor.toFixed(2) + ' BAR ADMITS (band ' + floor.toFixed(2) + '-' + (floor + 0.1).toFixed(2) + ')', 20)
}

const result = findClusters(open, index)
console.log(
  '\nCurrent thresholds ' +
    JSON.stringify(result.thresholds) +
    ' produce ' +
    result.clusters.length +
    ' clusters over ' +
    new Set(result.clusters.flatMap((c) => c.members)).size +
    ' issues.',
)
for (const cluster of result.clusters.slice(0, 12)) {
  console.log(
    '  ' +
      cluster.id +
      ' (' +
      cluster.members.length +
      ' members, cohesion ' +
      cluster.cohesion.toFixed(2) +
      ') ' +
      cluster.sharedTerms.join(', '),
  )
  for (const member of cluster.members) {
    console.log(
      '      ' +
        (member === cluster.canonical ? '*' : ' ') +
        ' #' +
        member +
        ' ' +
        (titles.get(member) ?? '').slice(0, 88),
    )
  }
}
