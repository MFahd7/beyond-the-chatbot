/** Sanity-check the docket from the command line, without the interface. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildDocket } from '../core/docket'
import { emptyModel } from '../core/operator'
import type { Corpus, Weights } from '../core/types'

const read = <T,>(f: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'data', f), 'utf8')) as T
const corpus = read<Corpus>('corpus.json')
const weights = read<Weights>('weights.json')

const now = new Date(process.env.DOCKET_NOW ?? corpus.meta.builtAt)
const started = Date.now()
const { cases, suppressed, stats } = buildDocket({ corpus, weights, model: emptyModel(), now })
console.log('built in ' + (Date.now() - started) + 'ms')
console.log(JSON.stringify(stats, null, 1))
console.log('\n=== TOP 12 CASES ===')
for (const [i, c] of cases.slice(0, 12).entries()) {
  console.log(
    (i + 1) + '. [' + c.kind + '] ev=' + c.ev.toFixed(1) + ' conf=' + c.inference.confidence.toFixed(2) +
    ' impact=' + c.impact + ' auto=' + (c.autoAfter ?? '-'),
  )
  console.log('   ' + c.headline)
  console.log('   -> ' + c.action.summary.slice(0, 130))
  console.log('   signals: ' + c.signals.map((s) => s.id).join(', '))
}
console.log('\n=== SUPPRESSED (first 5) ===')
for (const s of suppressed.slice(0, 5)) console.log('  ' + s.kind + ' #' + s.issues.join(',') + ' -- ' + s.why)
