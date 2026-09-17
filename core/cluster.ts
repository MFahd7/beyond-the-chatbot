/**
 * Find the groups of open issues that are the same defect reported more than
 * once. This is the only part of the inference that has no labelled ground
 * truth: the repo's `discussion-is-duplicate` label is applied to discussions,
 * not issues, and maintainers close duplicates with a prose comment pointing
 * at another number, which the search API will not hand over. So this is
 * unsupervised, and the interface says so rather than borrowing the
 * classifier's credibility.
 *
 * Two similarity measures, because they fail in opposite directions:
 *
 *   cosine over TF-IDF   catches reports that use the same vocabulary in
 *                        different sentences. Misses paraphrase.
 *   trigram jaccard      catches titles that are the same sentence with one
 *                        word swapped, where the distinctive tokens differ but
 *                        nearly every character trigram matches.
 *
 * An issue pair links if either is convincing on its own, or if both are
 * moderately convincing at once.
 */

import type { DuplicateCluster, Issue } from './types'
import { cosine, jaccard, sharedTerms, trigrams, type SparseVector, type TfIdfIndex } from './text'

export interface ClusterOptions {
  /** Cosine alone is enough at or above this. */
  cosineStrong?: number
  /** Trigram overlap alone is enough at or above this. */
  titleStrong?: number
  /** Below the strong bars, both must clear these together. */
  cosineWeak?: number
  titleWeak?: number
  /**
   * A single-linkage component larger than this means the thresholds were too
   * loose for this neighbourhood, so it gets re-cut at a higher bar rather
   * than presented as one twelve-issue duplicate group.
   */
  maxClusterSize?: number
}

/**
 * These numbers were read off the output of scripts/tune-clusters.ts, not
 * chosen in advance, and the first guess was wrong in an instructive way.
 *
 * Body cosine on this corpus tops out around 0.55 and piles up between 0.2 and
 * 0.3, so an initial 0.62 bar found three clusters in a thousand issues. Worse,
 * the highest-cosine pairs were not the best duplicates: reports drifted
 * together on shared incidental vocabulary while genuine duplicates that
 * happened to be written in different words scored lower.
 *
 * Title trigram overlap turned out to be the more trustworthy of the two.
 * Duplicates agree on the title because the title is the one line a reporter
 * writes deliberately, and it contains no pasted output to drift on. So the
 * title leads and the body corroborates -- with a floor on the other measure
 * in both directions, since a title match with no body agreement at all is
 * usually two different bugs with the same generic error string, which is the
 * most common way to get this wrong.
 */
const DEFAULTS: Required<ClusterOptions> = {
  titleStrong: 0.56,
  cosineStrong: 0.46,
  cosineWeak: 0.3,
  titleWeak: 0.38,
  /** The floor the other measure must clear when one is convincing alone. */
  maxClusterSize: 5,
}

/** A strong score on one measure still needs the other not to contradict it. */
const CORROBORATION = { cosine: 0.14, title: 0.14 }

interface Pair {
  a: number
  b: number
  cosine: number
  title: number
}

class UnionFind {
  private parent = new Map<number, number>()

  find(x: number): number {
    let root = this.parent.get(x)
    if (root === undefined) {
      this.parent.set(x, x)
      return x
    }
    if (root === x) return x
    root = this.find(root)
    this.parent.set(x, root)
    return root
  }

  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

/**
 * Below this many issues, compare every pair exactly. 1,000 issues is 499,500
 * sparse dot products and runs in well under a second, so there is no reason
 * to approximate.
 */
const EXHAUSTIVE_BELOW = 2500

/**
 * Candidate generation for corpora too large to compare exhaustively: two
 * issues can only be duplicates if they share a reasonably distinctive term.
 *
 * This is a recall/cost trade and it does lose pairs. The first version capped
 * buckets at 60 and dropped the clearest duplicate in the backlog -- two
 * reports of `TypeError: Cannot read properties of undefined (reading 'call')`
 * -- because every term in the title is common enough to overflow its bucket.
 * The cap is now generous and the exact path handles anything this corpus's
 * size, which is why the published clusters have no recall loss at all.
 */
function candidates(index: TfIdfIndex, ids: number[]): Set<string> {
  const pairs = new Set<string>()

  if (ids.length <= EXHAUSTIVE_BELOW) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i] as number
        const b = ids[j] as number
        pairs.add(a < b ? a + ':' + b : b + ':' + a)
      }
    }
    return pairs
  }

  const byTerm = new Map<string, number[]>()
  for (const id of ids) {
    const vector = index.vectors.get(id)
    if (!vector) continue
    const top = [...vector.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    for (const [term] of top) {
      const bucket = byTerm.get(term)
      if (bucket) bucket.push(id)
      else byTerm.set(term, [id])
    }
  }

  for (const bucket of byTerm.values()) {
    if (bucket.length < 2 || bucket.length > 400) continue
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i] as number
        const b = bucket[j] as number
        pairs.add(a < b ? a + ':' + b : b + ':' + a)
      }
    }
  }
  return pairs
}

function links(pair: Pair, options: Required<ClusterOptions>): boolean {
  // Title leads: near-identical titles are the strongest evidence available,
  // as long as the bodies are not actively about different things.
  if (pair.title >= options.titleStrong && pair.cosine >= CORROBORATION.cosine) return true
  // Body leads: catches the paraphrased duplicate whose title was rewritten.
  if (pair.cosine >= options.cosineStrong && pair.title >= CORROBORATION.title) return true
  // Neither is conclusive, but both agree.
  return pair.cosine >= options.cosineWeak && pair.title >= options.titleWeak
}

export interface ClusterResult {
  clusters: DuplicateCluster[]
  /** Every pair that cleared the bar, for threshold tuning and tests. */
  pairs: Pair[]
  thresholds: Required<ClusterOptions>
}

export function findClusters(
  issues: Issue[],
  index: TfIdfIndex,
  options: ClusterOptions = {},
): ClusterResult {
  const settings = { ...DEFAULTS, ...options }
  const byNumber = new Map(issues.map((i) => [i.number, i]))
  const ids = issues.map((i) => i.number)

  const titleGrams = new Map<number, Set<string>>()
  for (const issue of issues) titleGrams.set(issue.number, trigrams(issue.title))

  const scored: Pair[] = []
  for (const key of candidates(index, ids)) {
    const [left, right] = key.split(':')
    const a = Number(left)
    const b = Number(right)
    const va = index.vectors.get(a)
    const vb = index.vectors.get(b)
    if (!va || !vb) continue
    const c = cosine(va, vb)
    const t = jaccard(titleGrams.get(a) as Set<string>, titleGrams.get(b) as Set<string>)
    const pair = { a, b, cosine: c, title: t }
    if (links(pair, settings)) scored.push(pair)
  }

  const components = cut(scored, settings, settings.cosineStrong)
  const clusters: DuplicateCluster[] = []

  for (const members of components) {
    if (members.length < 2) continue
    const issuesIn = members
      .map((n) => byNumber.get(n))
      .filter((i): i is Issue => Boolean(i))
    if (issuesIn.length < 2) continue

    const canonical = pickCanonical(issuesIn)
    const canonicalVector = index.vectors.get(canonical.number) as SparseVector

    const similarities: Record<number, number> = {}
    let sum = 0
    let count = 0
    for (let i = 0; i < issuesIn.length; i++) {
      const vi = index.vectors.get((issuesIn[i] as Issue).number)
      if (!vi) continue
      similarities[(issuesIn[i] as Issue).number] = Number(cosine(canonicalVector, vi).toFixed(4))
      for (let j = i + 1; j < issuesIn.length; j++) {
        const vj = index.vectors.get((issuesIn[j] as Issue).number)
        if (!vj) continue
        sum += cosine(vi, vj)
        count++
      }
    }

    const others = issuesIn.filter((i) => i.number !== canonical.number)
    const terms = new Set<string>()
    for (const other of others) {
      const vo = index.vectors.get(other.number)
      if (!vo) continue
      for (const term of sharedTerms(canonicalVector, vo, 4)) terms.add(term)
    }

    clusters.push({
      id: 'dup-' + canonical.number,
      members: issuesIn.map((i) => i.number).sort((a, b) => a - b),
      canonical: canonical.number,
      cohesion: count > 0 ? Number((sum / count).toFixed(4)) : 0,
      sharedTerms: [...terms].slice(0, 6),
      similarities,
    })
  }

  clusters.sort((a, b) => b.members.length - a.members.length || b.cohesion - a.cohesion)
  return { clusters, pairs: scored, thresholds: settings }
}

/**
 * Single-linkage components, then tighten anything that blew up. A component
 * over the size cap is re-cut using only its strongest edges, recursively,
 * until every group is small enough to be a believable duplicate set.
 */
function cut(
  pairs: Pair[],
  options: Required<ClusterOptions>,
  bar: number,
  depth = 0,
): number[][] {
  const uf = new UnionFind()
  const seen = new Set<number>()
  for (const pair of pairs) {
    uf.union(pair.a, pair.b)
    seen.add(pair.a)
    seen.add(pair.b)
  }

  const groups = new Map<number, number[]>()
  for (const id of seen) {
    const root = uf.find(id)
    const group = groups.get(root)
    if (group) group.push(id)
    else groups.set(root, [id])
  }

  const out: number[][] = []
  for (const members of groups.values()) {
    if (members.length <= options.maxClusterSize || depth >= 4) {
      out.push(members)
      continue
    }
    const inside = new Set(members)
    const tighter = bar + 0.06
    const kept = pairs.filter(
      (p) => inside.has(p.a) && inside.has(p.b) && (p.cosine >= tighter || p.title >= tighter + 0.1),
    )
    if (kept.length === 0) {
      out.push(members)
      continue
    }
    out.push(...cut(kept, options, tighter, depth + 1))
  }
  return out
}

/**
 * Which member to keep open. The best-evidenced report, because that is the
 * one an engineer can actually work from -- not the oldest, which is the
 * convention on GitHub and is frequently the worst report in the group.
 */
function pickCanonical(issues: Issue[]): Issue {
  return [...issues].sort((a, b) => {
    const reproA = /https?:\/\/(github\.com|codesandbox|stackblitz)/i.test(a.body) ? 1 : 0
    const reproB = /https?:\/\/(github\.com|codesandbox|stackblitz)/i.test(b.body) ? 1 : 0
    if (reproA !== reproB) return reproB - reproA
    const engagementA = a.reactions * 2 + a.comments
    const engagementB = b.reactions * 2 + b.comments
    if (engagementA !== engagementB) return engagementB - engagementA
    if (a.body.length !== b.body.length) return b.body.length - a.body.length
    return a.createdAt < b.createdAt ? -1 : 1
  })[0] as Issue
}
