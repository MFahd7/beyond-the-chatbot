/** Exercise the failure path against a deployed docket: reject, repost the model, confirm the reorder. */
import { applyFeedback, emptyModel } from '../core/operator'
import type { DocketResponse } from '../app/api-types'

const BASE = process.argv[2] ?? 'http://localhost:3000'
const docket = async (model: unknown) =>
  (await (await fetch(BASE + '/api/docket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) })).json()) as DocketResponse

async function main() {
  const before = await docket(emptyModel())
  const target = before.cases.find((c) => c.provenance.source === 'model' && c.signals.some((s) => (s.push ?? 0) > 0)) ?? before.cases.find((c) => c.sweep)!
  const drivers = target.signals.filter((s) => (s.push ?? 0) > 0).slice(0, 3).map((s) => s.id)
  const t = { id: target.id, kind: target.kind, drivers: drivers.length ? drivers : target.signals.slice(0, 3).map((s) => s.id), temporal: target.signals.filter((s) => s.kind === 'temporal').map((s) => s.id), areas: target.issues.flatMap((i) => i.areas) }

  for (const reason of ['wrong_situation', 'not_my_area', 'wrong_priority'] as const) {
    const { model, event, summary } = applyFeedback({ model: emptyModel(), target: t, verdict: 'reject', reason, now: new Date(before.now) })
    const after = await docket(model)
    const gone = !after.cases.some((c) => c.id === target.id)
    const moved = before.cases.filter((c) => { const a = after.cases.find((x) => x.id === c.id); return a && Math.abs(a.ev - c.ev) > 1e-3 }).length
    console.log(reason.padEnd(16), '| case removed:', gone, '| adjustments:', event.adjustments.map((a) => a.target + ' ' + a.from + '->' + a.to).join(', ') || 'none', '| cases re-scored:', moved, '| covered+withheld:', after.stats.issuesCovered + after.stats.issuesWithheld)
    console.log('   ', summary[0])
  }
  const snooze = applyFeedback({ model: emptyModel(), target: t, verdict: 'snooze', now: new Date(before.now) })
  const s = await docket(snooze.model)
  console.log('snooze           | withheld reason:', s.suppressed.find((x) => x.id === target.id)?.why)
  console.log('target was:', target.id, target.kind, '-', target.headline.slice(0, 70))
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
