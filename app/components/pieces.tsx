/**
 * The parts a decision card is made of.
 *
 * Each of these exists because a specific thing has to be legible at a glance:
 * what kind of decision this is, where it came from, how sure the system is,
 * what evidence it used, and exactly what will happen if it is approved. None
 * of them render anything the operator has to interpret for themselves.
 */

import type { WireAction, WireCase, WireIssue, WireSignal } from '@/app/api-types'
import { KIND_LABEL, clock, duration, percent } from '@/core/format'

/** Per-kind custom properties, so the card's accent follows its decision. */
export function kindStyle(kind: string): React.CSSProperties {
  return {
    ['--kind-ink' as string]: 'var(--' + kind + '-ink)',
    ['--kind-bg' as string]: 'var(--' + kind + '-bg)',
    ['--kind-edge' as string]: 'var(--' + kind + '-edge)',
  }
}

export function KindTag({ kind, sweep }: { kind: string; sweep: number | null }) {
  return (
    <span className="kindTag">
      {KIND_LABEL[kind] ?? kind}
      {sweep !== null ? ' · sweep of ' + sweep : ''}
    </span>
  )
}

/**
 * Where this decision came from, stated on every card.
 *
 * A fitted model, a stated threshold and an unsupervised cluster are three
 * different kinds of claim, and a system that presents them identically is
 * lending its measured credibility to the parts that have none.
 */
export function Provenance({ provenance }: { provenance: WireCase['provenance'] }) {
  const word =
    provenance.source === 'model' ? 'fitted model' : provenance.source === 'rule' ? 'stated rule' : 'clustering'
  return (
    <span className="provenanceTag" title={provenance.detail}>
      {word}
    </span>
  )
}

export function Meter({
  label,
  value,
  note,
  bar,
}: {
  label: string
  value: string
  note?: string
  bar?: number
}) {
  return (
    <div className="meter">
      <div className="meterLabel">{label}</div>
      <div className="meterValue num">{value}</div>
      {note ? <div className="meterNote">{note}</div> : null}
      {bar !== undefined ? (
        <div className="confidenceTrack">
          <i style={{ width: Math.round(Math.min(Math.max(bar, 0), 1) * 100) + '%' }} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * One piece of evidence.
 *
 * The `push` column is the point. Two cards can both say "no reproduction" and
 * mean different things, because in one the signal carried the decision and in
 * the other it was outvoted. Showing the signed contribution is the difference
 * between an explanation and a list of true statements.
 */
export function SignalRow({ signal }: { signal: WireSignal }) {
  const push = signal.push
  const cls = push === undefined ? 'flat' : push > 0.01 ? 'for' : push < -0.01 ? 'against' : 'flat'
  return (
    <div className="signal">
      <div className="signalLabel">{signal.label}</div>
      <div className={'push ' + cls}>
        {push === undefined
          ? Math.round(signal.value * 100) + '%'
          : (push > 0 ? '+' : '') + push.toFixed(2)}
      </div>
      <div className="signalEvidence">{signal.evidence}</div>
    </div>
  )
}

function verbOf(request: string): { verb: string; rest: string } {
  const [verb, ...rest] = request.split(' ')
  return { verb: verb ?? '', rest: rest.join(' ') }
}

/**
 * What will actually happen, as the requests it becomes.
 *
 * Showing the REST call rather than a description is a deliberate cost: it is
 * uglier and it takes more room. It is also the only version an operator can
 * check. "Label as needs-repro" is a promise about behaviour; a POST with a
 * body is the behaviour.
 */
export function ActionBlock({ action }: { action: WireAction }) {
  const hidden = action.total - action.mutations.length
  return (
    <div className="action">
      <div className="actionSummary">{action.summary}</div>
      <div className="calls">
        {action.mutations.map((mutation, index) => {
          const { verb, rest } = verbOf(mutation.request)
          return (
            <div className="call" key={index}>
              <span className="callVerb">{verb}</span>
              <span className="callBody">{rest}</span>
              <span className={'stageTag ' + mutation.stage}>
                {mutation.stage === 'auto' ? 'automatic' : 'needs you'}
              </span>
            </div>
          )
        })}
        {hidden > 0 ? (
          <div className="call">
            <span className="callVerb">+{hidden}</span>
            <span className="callBody">
              more of the same across the rest of the set
            </span>
          </div>
        ) : null}
      </div>
      <div className="reversal">
        Undo: {action.reversal || 'nothing to undo'} · reversibility{' '}
        {percent(action.reversibility)}
      </div>
    </div>
  )
}

export function IssueTable({
  issues,
  canonical,
  total,
}: {
  issues: WireIssue[]
  canonical?: number
  total: number
}) {
  return (
    <>
      <table className="issues">
        <tbody>
          {issues.map((issue) => (
            <tr key={issue.number}>
              <td className="num">#{issue.number}</td>
              <td>
                <a href={issue.url} target="_blank" rel="noreferrer">
                  {issue.title}
                </a>
                {canonical === issue.number ? <span className="canonical"> · keep this one</span> : null}
                {issue.snippet ? <div className="signalEvidence">{issue.snippet}</div> : null}
              </td>
              <td className="meta">
                {issue.version ? issue.version + ' · ' : ''}
                {duration(issue.ageDays)} old
                <br />
                {issue.reactions} reactions · {issue.comments} comments
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > issues.length ? (
        <div className="signalEvidence" style={{ padding: '8px 9px' }}>
          Showing {issues.length} of {total}. Every member is listed in the approved action.
        </div>
      ) : null}
    </>
  )
}

/**
 * The autonomous action, counting down in the open.
 *
 * An action that applies itself has to be visible before it happens or it is
 * indistinguishable from a bug. The countdown is not a flourish: it is the
 * review. Any keystroke stops it, and the card says which mutations are in
 * scope and which are not.
 */
export function Countdown({
  seconds,
  total,
  halted,
  scope,
}: {
  seconds: number
  total: number
  halted: boolean
  scope: string
}) {
  if (halted) {
    return (
      <div className="countdown halted">
        <span>Held. Nothing applies itself until you move on.</span>
      </div>
    )
  }
  return (
    <div className="countdown">
      <strong>{clock(seconds)}</strong>
      <span>{scope}</span>
      <span className="countdownBar">
        <i style={{ width: Math.round((seconds / Math.max(total, 1)) * 100) + '%' }} />
      </span>
    </div>
  )
}

export function Section({
  title,
  children,
  aside,
}: {
  title: string
  children: React.ReactNode
  aside?: React.ReactNode
}) {
  return (
    <div className="section">
      <div className="sectionHead">
        <span>{title}</span>
        {aside}
      </div>
      {children}
    </div>
  )
}
