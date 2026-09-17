/**
 * Text handling for the corpus.
 *
 * The one thing that matters here: a bug report from a repo with an issue
 * template is mostly *not* the reporter's words. It is the template's words.
 * Every report contains "Link to the code that reproduces this issue",
 * "Provide environment information", a pasted `next info` dump, and usually a
 * stack trace. Run TF-IDF over that raw text and every issue looks like every
 * other issue -- cosine similarity lands around 0.6 for two completely
 * unrelated reports, and duplicate detection becomes noise.
 *
 * So the pipeline strips scaffolding first, in this order: fenced code, HTML
 * comments, template headings, environment dumps, URLs, then bare numbers.
 * What survives is the sentence or two the human actually typed, and that is
 * what gets vectorised.
 */

/** Lines the repo's own templates emit. Identical in every report, so noise. */
const TEMPLATE_HEADINGS = [
  'link to the code that reproduces this issue',
  'to reproduce',
  'current vs. expected behavior',
  'current vs expected behavior',
  'provide environment information',
  'which area(s) are affected? (select all that apply)',
  'which area(s) are affected?',
  'which stage(s) are affected? (select all that apply)',
  'which stage(s) are affected?',
  'additional context',
  'verify canary release',
  'verify latest canary',
  'describe the bug',
  'expected behavior',
  'actual behavior',
  'steps to reproduce',
  'what version of next.js are you using',
  'what browser are you using',
  'what operating system are you using',
  'how are you deploying your application',
  'describe the feature you want',
  'i verified that the issue exists in the latest next.js canary release',
]

const STOPWORDS = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being ' +
    'below between both but by can cannot could did do does doing down during each few for from ' +
    'further had has have having he her here hers him his how i if in into is it its itself just ' +
    'me more most my no nor not of off on once only or other our out over own same she should so ' +
    'some such than that the their them then there these they this those through to too under ' +
    'until up very was we were what when where which while who whom why will with would you your ' +
    // Report boilerplate. These carry no discriminating power in a bug tracker.
    'issue issues bug bugs report reports reproduce reproduction repro link provide environment ' +
    'information version versions expected actual behavior behaviour context additional select ' +
    'apply area areas stage stages affected verify canary latest release please also using use ' +
    'used get got getting following follows happens happen happening instead however seems like ' +
    'tried try trying works work working code example app application project file files line ' +
    'lines log logs output run running node npm yarn pnpm bun dev build start production ' +
    'description describe steps step details detail thanks thank hello hi'
  ).split(' '),
)

/** Remove fenced and indented code, which is where stack traces live. */
export function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]{1,200}`/g, ' ')
    .replace(/^ {4,}\S.*$/gm, ' ')
}

/** Remove the template's own prompts, leaving only what was typed into them. */
export function stripTemplate(text: string): string {
  let out = text.replace(/<!--[\s\S]*?-->/g, ' ')
  for (const heading of TEMPLATE_HEADINGS) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp('#{1,6}\\s*' + escaped + '.*$', 'gim'), ' ')
    out = out.replace(new RegExp('^\\s*' + escaped + '\\s*$', 'gim'), ' ')
  }
  // The `next info` dump: a block of "Key: value" lines naming platforms.
  out = out.replace(
    /^\s*(operating system|platform|arch|version|binaries|node|npm|yarn|pnpm|relevant packages|next|eslint-config-next|react|react-dom|typescript|available memory|available cpu cores|cpu)\s*:.*$/gim,
    ' ',
  )
  // Checklist rows and markdown furniture.
  out = out.replace(/^\s*[-*]\s*\[[ xX]\]\s*/gm, ' ')
  out = out.replace(/^\s*[-*+]\s+/gm, ' ')
  out = out.replace(/^\s*#{1,6}\s*/gm, ' ')
  out = out.replace(/\|/g, ' ')
  return out
}

export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, ' ').replace(/\bwww\.\S+/g, ' ')
}

/**
 * Remove embedded images and raw HTML.
 *
 * This one was found by reading the output rather than by reasoning about it.
 * Two entirely unrelated reports -- one about memory use at startup, one about
 * a source-map read failure -- scored 0.45 cosine against each other because
 * both pasted a screenshot, and GitHub expands a pasted screenshot into an
 * `<img width alt src height>` tag. The shared vocabulary was the attachment
 * markup. Every report with a screenshot was drifting toward every other
 * report with a screenshot.
 */
export function stripMarkup(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/<details>|<\/details>|<summary>|<\/summary>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
}

/**
 * The prose a human actually wrote, with everything mechanical removed.
 * Used both for vectorising and for the `proseLength` signal, because "this
 * report is 40 characters of English wrapped in 3kB of template" is exactly
 * the thing a maintainer notices and the raw body length hides.
 */
export function prose(body: string): string {
  return stripUrls(stripMarkup(stripTemplate(stripCode(body))))
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9_.-]+/)) {
    // Keep dotted identifiers (next.config, app.tsx) but drop bare version
    // numbers and standalone punctuation.
    const token = raw.replace(/^[.\-_]+|[.\-_]+$/g, '')
    if (token.length < 3 || token.length > 32) continue
    if (STOPWORDS.has(token)) continue
    if (/^\d+$/.test(token)) continue
    if (/^\d+\.\d/.test(token)) continue
    out.push(token)
  }
  return out
}

export type SparseVector = Map<string, number>

export interface TfIdfIndex {
  /** Token -> inverse document frequency. */
  idf: Map<string, number>
  /** Document id -> L2-normalised sparse vector. */
  vectors: Map<number, SparseVector>
  documentCount: number
  vocabulary: number
}

export interface IndexOptions {
  /** Drop tokens appearing in fewer documents than this. Kills typos. */
  minDf?: number
  /** Drop tokens appearing in more than this share of documents. Kills boilerplate. */
  maxDfRatio?: number
}

/**
 * Build the index. Sublinear term frequency (1 + log tf) because a stack trace
 * that says "webpack" thirty times is not thirty times more about webpack.
 */
export function buildIndex(
  docs: { id: number; text: string }[],
  options: IndexOptions = {},
): TfIdfIndex {
  const minDf = options.minDf ?? 2
  const maxDfRatio = options.maxDfRatio ?? 0.4

  const tokenised = new Map<number, string[]>()
  const df = new Map<string, number>()

  for (const doc of docs) {
    const tokens = tokenize(doc.text)
    tokenised.set(doc.id, tokens)
    for (const token of new Set(tokens)) {
      df.set(token, (df.get(token) ?? 0) + 1)
    }
  }

  const n = docs.length
  const maxDf = Math.max(minDf, Math.floor(n * maxDfRatio))
  const idf = new Map<string, number>()
  for (const [token, count] of df) {
    if (count < minDf || count > maxDf) continue
    idf.set(token, Math.log(1 + n / count))
  }

  const vectors = new Map<number, SparseVector>()
  for (const doc of docs) {
    const counts = new Map<string, number>()
    for (const token of tokenised.get(doc.id) ?? []) {
      if (!idf.has(token)) continue
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
    const vector: SparseVector = new Map()
    let norm = 0
    for (const [token, tf] of counts) {
      const weight = (1 + Math.log(tf)) * (idf.get(token) as number)
      vector.set(token, weight)
      norm += weight * weight
    }
    norm = Math.sqrt(norm)
    if (norm > 0) {
      for (const [token, weight] of vector) vector.set(token, weight / norm)
    }
    vectors.set(doc.id, vector)
  }

  return { idf, vectors, documentCount: n, vocabulary: idf.size }
}

/** Both vectors are already L2-normalised, so the dot product is the cosine. */
export function cosine(a: SparseVector, b: SparseVector): number {
  // Walk the shorter one.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let sum = 0
  for (const [token, weight] of small) {
    const other = large.get(token)
    if (other !== undefined) sum += weight * other
  }
  return sum
}

/** The tokens two documents share, heaviest first. Used as human evidence. */
export function sharedTerms(a: SparseVector, b: SparseVector, limit = 6): string[] {
  const shared: { token: string; weight: number }[] = []
  for (const [token, weight] of a) {
    const other = b.get(token)
    if (other !== undefined) shared.push({ token, weight: weight * other })
  }
  shared.sort((x, y) => y.weight - x.weight)
  return shared.slice(0, limit).map((s) => s.token)
}

/**
 * Character trigrams over the title, for the near-duplicate case TF-IDF misses:
 * two titles that are the same sentence with one word changed share few
 * distinctive tokens but almost all their trigrams.
 */
export function trigrams(text: string): Set<string> {
  const normalised = ' ' + text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' '
  const out = new Set<string>()
  for (let i = 0; i + 3 <= normalised.length; i++) out.add(normalised.slice(i, i + 3))
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const item of small) if (large.has(item)) intersection++
  return intersection / (a.size + b.size - intersection)
}

/** A short, quotable fragment of what the reporter said. For evidence lines. */
export function snippet(body: string, limit = 150): string {
  const text = prose(body)
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut) + '...'
}
