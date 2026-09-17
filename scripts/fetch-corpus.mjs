/**
 * Pull the real vercel/next.js issue backlog off the GitHub search API.
 *
 * Two things come back, and they serve different purposes:
 *
 *   1. Every OPEN issue. This is the live backlog the docket triages. It is the
 *      same set of rows a maintainer sees at github.com/vercel/next.js/issues.
 *
 *   2. CLOSED issues grouped by the triage label the maintainers actually
 *      applied. These are not decoration. Each one is a recorded human
 *      decision -- this needed a reproduction, this went stale, this was real
 *      and got routed to the internal tracker -- and they are what
 *      scripts/fit-weights.mjs fits the intent scorer against.
 *
 * Unauthenticated search allows 10 requests/minute, so this paces itself and
 * caches every page under data/raw/. Re-running is cheap; only missing pages
 * are fetched. Set GITHUB_TOKEN to go to 30/minute.
 *
 *   node scripts/fetch-corpus.mjs            # fill in whatever is missing
 *   node scripts/fetch-corpus.mjs --force    # ignore the cache, re-pull
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const REPO = process.env.CORPUS_REPO ?? 'vercel/next.js'
const RAW = path.join(process.cwd(), 'data', 'raw')
const FORCE = process.argv.includes('--force')
const TOKEN = (process.env.GITHUB_TOKEN ?? '').trim()

/** Unauthenticated search is 10/min. Leave headroom rather than racing it. */
const PACE_MS = TOKEN ? 2200 : 6800
const PER_PAGE = 100
/** The search API refuses to page past 1000 results for any single query. */
const SEARCH_CEILING = 1000

/**
 * The outcome classes. The label in each query is a real label in the repo's
 * own taxonomy, which is why these are worth learning from: they record what a
 * maintainer did, not what we wish they had done.
 *
 * The caps are deliberately uneven because the real distribution is uneven,
 * and fit-weights.mjs accounts for that rather than pretending otherwise.
 */
const CLASSES = [
  {
    id: 'needs_repro',
    cap: 400,
    query: 'is:closed label:"please add a complete reproduction"',
    means: 'Maintainer could not act without a runnable reproduction.',
  },
  {
    id: 'verify_canary',
    cap: 300,
    query: 'is:closed label:"please verify canary"',
    means: 'Maintainer suspected the bug was already fixed on canary.',
  },
  {
    id: 'stale_close',
    cap: 400,
    query: 'is:closed label:"stale"',
    means: 'Issue expired without enough signal to act on.',
  },
  {
    id: 'accepted_route',
    cap: 400,
    query: 'is:closed label:"linear: next","linear: turbopack"',
    means: 'Accepted as a real defect and routed to the internal tracker.',
  },
  {
    id: 'fixed_direct',
    cap: 300,
    query:
      'is:closed reason:completed -label:"stale" ' +
      '-label:"please add a complete reproduction" -label:"please verify canary" ' +
      '-label:"linear: next" -label:"linear: turbopack"',
    means: 'Closed as completed with no triage friction at all.',
  },
]

/**
 * The era-stratified pool, and the reason it exists.
 *
 * The triage labels above are not spread evenly through history. The team's
 * process changed: `please add a complete reproduction` is mostly 2022-23,
 * `stale` sweeps happened in 2024, `linear:` routing started in 2024, and
 * anything closed this year is naturally still being worked. Sample each label
 * by "most recent N" and the classes come back almost temporally disjoint --
 * at which point a classifier fitted on them learns what year it is looking at
 * and nothing else. Applied to a backlog that is mostly current, it would
 * confidently predict one class for everything.
 *
 * So the ground truth the model is actually fitted against is the one outcome
 * GitHub records in a way the team's process cannot drift: did this issue get
 * closed as *completed* (someone fixed it) or *not planned* (it was closed
 * without a fix). Both exist in volume in every year, so the pool below is
 * drawn per-year and evened out before fitting. Nothing can be learned from
 * the calendar if every year contributes the same number of each class.
 *
 * The same pool doubles as the era-matched negative set for the per-label
 * action models: for any label, negatives are drawn from these rows following
 * the positives' own year distribution.
 */
const ERAS = ['2022', '2023', '2024', '2025', '2026']
const ERA_CAP = 200

const RESOLUTIONS = [
  {
    id: 'completed',
    query: 'is:closed reason:completed',
    means: 'Someone fixed it. The report was actionable.',
  },
  {
    id: 'not_planned',
    query: 'is:closed reason:"not planned"',
    means: 'Closed without a fix. The report did not survive triage.',
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let lastCall = 0

async function paced(url) {
  const wait = PACE_MS - (Date.now() - lastCall)
  if (wait > 0) await sleep(wait)
  lastCall = Date.now()

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'docket-corpus-builder',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers })
    if (res.ok) return res.json()

    // 403 and 429 both mean "slow down" here. Prefer the server's own advice
    // about when to come back over a guess of ours.
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 0)
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0)
      const byReset = reset ? reset * 1000 - Date.now() + 1500 : 0
      const backoff = Math.max(retryAfter * 1000, byReset, 15000 * (attempt + 1))
      console.log('    rate limited, waiting ' + Math.round(backoff / 1000) + 's')
      await sleep(backoff)
      lastCall = Date.now()
      continue
    }
    throw new Error('GitHub returned ' + res.status + ' for ' + url + '\n' + (await res.text()))
  }
  throw new Error('Gave up after repeated rate limiting: ' + url)
}

/** Only the fields the pipeline reads, and bodies clipped to something sane. */
function slim(issue) {
  return {
    number: issue.number,
    title: issue.title ?? '',
    body: (issue.body ?? '').slice(0, 9000),
    state: issue.state,
    state_reason: issue.state_reason ?? null,
    labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at ?? null,
    comments: issue.comments ?? 0,
    reactions: issue.reactions?.total_count ?? 0,
    author: issue.user?.login ?? null,
    author_association: issue.author_association ?? null,
    assignees: (issue.assignees ?? []).map((a) => a.login),
    milestone: issue.milestone?.title ?? null,
    locked: Boolean(issue.locked),
    html_url: issue.html_url,
  }
}

async function cachedPage(key, url) {
  const file = path.join(RAW, key + '.json')
  if (!FORCE && existsSync(file)) {
    const cached = JSON.parse(await readFile(file, 'utf8'))
    return { ...cached, cached: true }
  }
  const json = await paced(url)
  const page = {
    total_count: json.total_count ?? 0,
    incomplete: Boolean(json.incomplete_results),
    items: (json.items ?? []).map(slim),
  }
  await writeFile(file, JSON.stringify(page), 'utf8')
  return { ...page, cached: false }
}

/**
 * Page through one search query up to the API's 1000-result ceiling.
 * Returns the items plus the true total, so the caller can tell when a query
 * matched more than it could hand back.
 */
async function search(keyPrefix, query, cap) {
  const full = 'repo:' + REPO + ' is:issue ' + query
  const items = []
  let total = 0

  const pages = Math.ceil(Math.min(cap, SEARCH_CEILING) / PER_PAGE)
  for (let page = 1; page <= pages; page++) {
    const url =
      'https://api.github.com/search/issues?q=' +
      encodeURIComponent(full) +
      '&sort=created&order=desc&per_page=' +
      PER_PAGE +
      '&page=' +
      page
    const res = await cachedPage(keyPrefix + '-p' + page, url)
    total = res.total_count
    items.push(...res.items)
    console.log(
      '    page ' +
        page +
        ': +' +
        res.items.length +
        (res.cached ? ' (cached)' : '') +
        ' -> ' +
        items.length +
        '/' +
        Math.min(cap, total),
    )
    if (res.items.length < PER_PAGE || items.length >= cap) break
  }
  return { items: items.slice(0, cap), total }
}

async function main() {
  await mkdir(RAW, { recursive: true })
  console.log('Repo:  ' + REPO)
  console.log('Auth:  ' + (TOKEN ? 'GITHUB_TOKEN set (30 req/min)' : 'none (10 req/min)'))
  console.log('Cache: ' + RAW + (FORCE ? ' (ignored, --force)' : '') + '\n')

  console.log('Open backlog -- the set the docket triages')
  const open = await search('open', 'is:open', SEARCH_CEILING)
  console.log('  ' + open.items.length + ' open issues (repo reports ' + open.total + ')\n')

  const training = {}
  for (const klass of CLASSES) {
    console.log('Outcome "' + klass.id + '" -- ' + klass.means)
    const got = await search(klass.id, klass.query, klass.cap)
    training[klass.id] = got.items
    console.log('  ' + got.items.length + ' examples (' + got.total + ' exist in the repo)\n')
  }

  console.log('Era-stratified resolution pool -- the leak-proof ground truth')
  const eras = {}
  for (const resolution of RESOLUTIONS) {
    for (const year of ERAS) {
      const key = resolution.id + ':' + year
      const scoped = resolution.query + ' created:' + year + '-01-01..' + year + '-12-31'
      const got = await search('era-' + resolution.id + '-' + year, scoped, ERA_CAP)
      eras[key] = got.items
      console.log('  ' + key.padEnd(18) + got.items.length + ' of ' + got.total + ' in that year')
    }
  }
  console.log('')

  const manifest = {
    repo: REPO,
    fetched_at: new Date().toISOString(),
    source: 'GitHub REST search API v2022-11-28, unauthenticated-capable',
    open_count: open.items.length,
    open_total_reported: open.total,
    search_ceiling: SEARCH_CEILING,
    classes: CLASSES.map((c) => ({
      id: c.id,
      means: c.means,
      query: 'repo:' + REPO + ' is:issue ' + c.query,
      fetched: training[c.id].length,
    })),
    eras: {
      years: ERAS,
      cap_per_cell: ERA_CAP,
      resolutions: RESOLUTIONS.map((r) => ({
        id: r.id,
        means: r.means,
        query: 'repo:' + REPO + ' is:issue ' + r.query,
        per_year: Object.fromEntries(ERAS.map((y) => [y, eras[r.id + ':' + y].length])),
      })),
    },
  }

  await writeFile(path.join(RAW, 'open.json'), JSON.stringify(open.items), 'utf8')
  await writeFile(path.join(RAW, 'training.json'), JSON.stringify(training), 'utf8')
  await writeFile(path.join(RAW, 'eras.json'), JSON.stringify(eras), 'utf8')
  await writeFile(path.join(RAW, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  const trainTotal = Object.values(training).reduce((n, v) => n + v.length, 0)
  const eraTotal = Object.values(eras).reduce((n, v) => n + v.length, 0)
  console.log('Wrote data/raw/{open,training,eras,manifest}.json')
  console.log(
    open.items.length +
      ' open issues, ' +
      trainTotal +
      ' labelled triage actions, ' +
      eraTotal +
      ' era-stratified resolutions.',
  )
  console.log('Next: npm run data:build')
}

main().catch((err) => {
  console.error('\nFetch failed: ' + err.message)
  process.exitCode = 1
})
