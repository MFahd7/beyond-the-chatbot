'use client'

/**
 * The interface.
 *
 * One decision on screen. Approve, edit, reject with a reason, or defer, all
 * from the keyboard, and the next decision is already prepared. There is no
 * search box, no list, no filters and no chat input, because every one of
 * those would be asking the operator to do the part the system claims to have
 * done.
 *
 * Three things here are load-bearing rather than decorative:
 *
 *   The countdown. One action applies itself, and it does so in front of you
 *   with a timer and a description of exactly which requests are in scope.
 *   Any keystroke stops it. An autonomous action nobody can see coming is
 *   indistinguishable from a bug.
 *
 *   The reject reasons. Rejection is the highest-bandwidth input in the
 *   interface, so it is never a thumbs-down. Five reasons, each editing a
 *   different part of the model, and the panel that follows shows the
 *   multipliers that moved and the cases that reordered as a result. An
 *   operator who cannot see what their correction did has no reason to make
 *   another one.
 *
 *   The escape hatches. `?` lists everything being withheld and why, `i`
 *   shows the held-out numbers including the models that were cut, and `\`
 *   puts the thing being replaced next to the thing replacing it. The claim
 *   "this is the decision to make next" is only acceptable if it can be
 *   audited without leaving the screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { DocketResponse, WireCase } from '@/app/api-types'
import type { OperatorModel, RejectReason } from '@/core/types'
import { applyFeedback, deviations, emptyModel } from '@/core/operator'
import { KIND_LABEL, REASON_LABEL, countOf, percent } from '@/core/format'
import { ActionBlock, Countdown, IssueTable, KindTag, Meter, Provenance, Section, kindStyle } from './pieces'
import { Compare, ModelCard, Suppressed } from './overlays'

const STORAGE_KEY = 'docket.operator.v1'

const REJECT_REASONS: { key: string; id: RejectReason; what: string }[] = [
  { key: '1', id: 'wrong_situation', what: 'Distrusts the signals that drove this reading, everywhere they appear.' },
  { key: '2', id: 'wrong_action', what: 'Keeps the reading, demotes this kind of response.' },
  { key: '3', id: 'wrong_priority', what: 'Right call, wrong moment. Drops it down the order but keeps it.' },
  { key: '4', id: 'not_my_area', what: 'Demotes these areas without touching the reasoning.' },
  { key: '5', id: 'stale_evidence', what: 'Distrusts the time-based evidence on this reading.' },
]

interface AppliedEntry {
  caseId: string
  headline: string
  requests: number
  at: string
  automatic: boolean
}

interface ChangeNote {
  summary: string[]
  adjustments: { target: string; from: number; to: number; note: string }[]
  before: { id: string; headline: string }[]
}

export function Docket() {
  const [data, setData] = useState<DocketResponse | null>(null)
  const [model, setModel] = useState<OperatorModel>(emptyModel())
  const [cursor, setCursor] = useState(0)
  const [mode, setMode] = useState<'deciding' | 'rejecting' | 'editing'>('deciding')
  const [overlay, setOverlay] = useState<null | 'compare' | 'suppressed' | 'models'>(null)
  const [change, setChange] = useState<ChangeNote | null>(null)
  const [applied, setApplied] = useState<AppliedEntry[]>([])
  const [autoFired, setAutoFired] = useState<Record<string, string>>({})
  const [remaining, setRemaining] = useState<number | null>(null)
  const [halted, setHalted] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const loadedRef = useRef(false)

  /** Restore what the operator taught the system on a previous visit. */
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) setModel(JSON.parse(saved) as OperatorModel)
    } catch {
      // Private browsing, blocked storage, anything. A fresh operator is a
      // perfectly good fallback and the interface is identical either way.
    }
  }, [])

  /**
   * Send the approved draft. Dry run unless the deployment is configured with
   * a write token and a target repository it owns; either way the response
   * reports exactly which requests were in scope, so the log the operator sees
   * is the truth about what happened.
   */
  const execute = useCallback(
    async (caseId: string, scope: 'auto' | 'all', next: OperatorModel) => {
      try {
        const response = await fetch('/api/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ caseId, scope, model: next }),
        })
        const result = (await response.json()) as { mode?: string; requested?: number }
        return result
      } catch {
        return { mode: 'failed', requested: 0 }
      }
    },
    [],
  )

  const fetchDocket = useCallback(async (next: OperatorModel) => {
    setBusy(true)
    try {
      const response = await fetch('/api/docket', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: next }),
      })
      setData((await response.json()) as DocketResponse)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void fetchDocket(model)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(model))
    } catch {
      // Not being able to remember is not a reason to stop working.
    }
  }, [model, fetchDocket])

  const cases = data?.cases ?? []
  const current: WireCase | undefined = cases[Math.min(cursor, Math.max(cases.length - 1, 0))]

  /**
   * The countdown for the one autonomous action.
   *
   * Reset whenever the card changes, halted by any interaction, and stopped
   * entirely while an overlay is open -- the operator is reading, not
   * consenting.
   */
  useEffect(() => {
    setRemaining(current?.autoAfter ?? null)
    setHalted(false)
  }, [current?.id, current?.autoAfter])

  useEffect(() => {
    if (remaining === null || halted || overlay !== null || mode !== 'deciding') return
    if (!current) return
    if (autoFired[current.id]) return

    if (remaining <= 0) {
      const at = new Date().toISOString()
      setAutoFired((prev) => ({ ...prev, [current.id]: at }))
      void execute(current.id, 'auto', model)
      setApplied((prev) => [
        {
          caseId: current.id,
          headline: current.headline,
          requests: current.action.autonomous,
          at,
          automatic: true,
        },
        ...prev,
      ])
      return
    }

    const timer = setTimeout(() => setRemaining((value) => (value === null ? null : value - 1)), 1000)
    return () => clearTimeout(timer)
  }, [remaining, halted, overlay, mode, current, autoFired, execute, model])

  const settle = useCallback(
    (verdict: 'approve' | 'edit' | 'reject' | 'snooze', reason?: RejectReason) => {
      if (!current || !data) return

      const before = cases.slice(0, 6).map((c) => ({ id: c.id, headline: c.headline }))

      // Feedback is applied here, on the client, using the same core module
      // the server builds the docket with. The docket is then rebuilt from the
      // updated model, so what the operator sees is the actual consequence of
      // their correction rather than an optimistic guess at it.
      // Feedback is applied here, on the client, using the same core module the
      // server builds the docket with — so what appears next is the actual
      // consequence of the correction rather than an optimistic guess at it.
      const result = applyFeedback({
        model,
        target: {
          id: current.id,
          kind: current.kind,
          drivers: current.signals
            .filter((s) => (s.push ?? 0) > 0)
            .slice(0, 3)
            .map((s) => s.id),
          temporal: current.signals.filter((s) => s.kind === 'temporal').map((s) => s.id),
          areas: current.issues.flatMap((issue) => issue.areas),
        },
        verdict,
        reason: reason ?? null,
        now: new Date(data.now),
      })

      if (verdict === 'approve' || verdict === 'edit') {
        void execute(current.id, 'all', model)
        setApplied((prev) => [
          {
            caseId: current.id,
            headline: current.headline,
            requests: current.action.total,
            at: new Date().toISOString(),
            automatic: false,
          },
          ...prev,
        ])
      }

      setChange({ summary: result.summary, adjustments: result.event.adjustments, before })
      setCursor(0)
      setMode('deciding')
      setDraft('')
      setModel(result.model)
    },
    [current, data, cases, model, execute],
  )

  const reset = useCallback(() => {
    setChange(null)
    setApplied([])
    setAutoFired({})
    setCursor(0)
    setModel(emptyModel())
  }, [])

  /** Every shortcut in the interface. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key

      if (key === 'Escape') {
        if (overlay) setOverlay(null)
        else if (mode !== 'deciding') setMode('deciding')
        return
      }

      if (overlay) return

      if (mode === 'editing') {
        if ((key === 'Enter' && (event.metaKey || event.ctrlKey)) === true) {
          event.preventDefault()
          settle('edit')
        }
        return
      }

      // Any key means the operator is present, so the autonomous countdown
      // stops. Consent has to be active, not merely unobjected-to.
      setHalted(true)

      if (mode === 'rejecting') {
        const chosen = REJECT_REASONS.find((r) => r.key === key)
        if (chosen) {
          event.preventDefault()
          settle('reject', chosen.id)
        }
        return
      }

      switch (key) {
        case 'Enter':
          event.preventDefault()
          settle('approve')
          break
        case 'e':
          setDraft(
            current?.action.mutations.find((m) => m.kind === 'comment')?.payload ??
              current?.action.summary ??
              '',
          )
          setMode('editing')
          break
        case 'r':
          setMode('rejecting')
          break
        case 's':
          settle('snooze')
          break
        case 'j':
        case 'ArrowDown':
          setCursor((c) => Math.min(c + 1, Math.max(cases.length - 1, 0)))
          break
        case 'k':
        case 'ArrowUp':
          setCursor((c) => Math.max(c - 1, 0))
          break
        case '\\':
          setOverlay('compare')
          break
        case '?':
          setOverlay('suppressed')
          break
        case 'i':
          setOverlay('models')
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay, mode, settle, cases.length, current])

  const drift = useMemo(() => deviations(model), [model])

  if (!data) {
    return (
      <div className="shell">
        <div className="loading">reading the backlog…</div>
      </div>
    )
  }

  const stats = data.stats
  const autoAt = current ? autoFired[current.id] : undefined

  return (
    <div className="shell">
      <header className="topbar">
        <span className="wordmark">DOCKET</span>
        <span className="sep">/</span>
        <a href={'https://github.com/' + data.meta.repo + '/issues'} target="_blank" rel="noreferrer">
          {data.meta.repo}
        </a>
        <span className="sep">·</span>
        <span>
          <strong style={{ color: 'var(--text)' }}>{stats.openReported.toLocaleString()}</strong> open
          issues
        </span>
        <span className="sep">→</span>
        <span>
          <strong style={{ color: 'var(--text)' }}>{stats.cases}</strong> decisions
        </span>
        <span className="sep">·</span>
        <span>
          {stats.decisions} judgments, {stats.sweeps} sweeps
        </span>
        <span className="grow" />
        {drift.signals.length + drift.kinds.length + drift.areas.length > 0 ? (
          <span className="pill" title="What your corrections have changed">
            tuned: <strong>{drift.signals.length + drift.kinds.length + drift.areas.length}</strong>{' '}
            adjustments
            <button className="textButton" onClick={reset} style={{ marginLeft: 6 }}>
              reset
            </button>
          </span>
        ) : null}
        {busy ? <span className="pill">rebuilding…</span> : null}
      </header>

      <main className="main">
        <div className="column">
          {!current ? (
            <div className="empty">
              <div className="emptyTitle">Docket clear.</div>
              <p className="emptyBody">
                {applied.length > 0
                  ? countOf(applied.length, 'decision') +
                    ' made this session. Everything else in the backlog is either covered by a ' +
                    'decision you settled or listed in what is being withheld.'
                  : 'Nothing reached the confidence floor. That is an answer too.'}
              </p>
              <button className="ghostButton" onClick={() => setOverlay('suppressed')}>
                show what is being withheld ({stats.issuesWithheld})
              </button>
            </div>
          ) : (
            <article className="case" style={kindStyle(current.kind)}>
              <div className="caseTop">
                <span className="position">
                  {Math.min(cursor + 1, cases.length)} / {cases.length}
                </span>
                <KindTag kind={current.kind} sweep={current.sweep?.count ?? null} />
                <Provenance provenance={current.provenance} />
                <span className="grow" />
                <span>{current.provenance.detail}</span>
              </div>

              <h1 className="headline">{current.headline}</h1>
              <p className="situation">{current.situation}</p>

              {current.autoAfter !== null && !autoAt ? (
                <Countdown
                  seconds={remaining ?? current.autoAfter}
                  total={current.autoAfter}
                  halted={halted}
                  scope={
                    'Applying ' +
                    countOf(current.action.autonomous, 'reversible label') +
                    ' on its own. The comments and closes in this set wait for you.'
                  }
                />
              ) : null}

              {autoAt ? (
                <div className="countdown">
                  <strong>applied</strong>
                  <span>
                    {countOf(current.action.autonomous, 'label')} applied automatically at{' '}
                    {autoAt.slice(11, 19)}. Reversible; nobody was notified.
                  </span>
                </div>
              ) : null}

              <Section title="Why">
                <div className="rows">
                  {current.signals.length > 0 ? (
                    current.signals.map((signal) => (
                      <SignalLine key={signal.id} signal={signal} />
                    ))
                  ) : (
                    <div className="signal">
                      <div className="signalLabel">Selected by a stated rule</div>
                      <div className="push flat">rule</div>
                      <div className="signalEvidence">{current.provenance.detail}</div>
                    </div>
                  )}
                </div>
              </Section>

              <Section
                title="Prepared"
                aside={
                  current.action.autonomous > 0 ? (
                    <span className="stageTag auto">{current.action.autonomous} automatic</span>
                  ) : null
                }
              >
                <ActionBlock action={current.action} />
              </Section>

              {mode === 'editing' ? (
                <Section title="Edit before sending">
                  <textarea
                    className="editArea"
                    value={draft}
                    autoFocus
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="ghostButton" onClick={() => settle('edit')}>
                      send edited <kbd>⌘⏎</kbd>
                    </button>
                    <button className="ghostButton" onClick={() => setMode('deciding')}>
                      cancel <kbd>esc</kbd>
                    </button>
                  </div>
                </Section>
              ) : null}

              {mode === 'rejecting' ? (
                <div className="reject">
                  <div className="rejectTitle">What did it get wrong?</div>
                  <div className="rejectHint">
                    Each answer edits a different part of the model. &ldquo;Wrong&rdquo; is not one
                    piece of information, and a thumbs-down throws away the useful part.
                  </div>
                  <div className="reasons">
                    {REJECT_REASONS.map((reason) => (
                      <button
                        key={reason.id}
                        className="reason"
                        onClick={() => settle('reject', reason.id)}
                      >
                        <span className="reasonKey">{reason.key}</span>
                        <span>
                          <span className="reasonName">{REASON_LABEL[reason.id]}</span>
                          <br />
                          <span className="reasonWhat">{reason.what}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {change ? <Changed change={change} cases={cases} /> : null}

              <div className="meters">
                <Meter
                  label="confidence"
                  value={percent(current.confidence)}
                  note={
                    current.margin > 0
                      ? '+' + current.margin.toFixed(2) + ' over the runner-up'
                      : current.provenance.source === 'rule'
                        ? 'threshold strength, not a probability'
                        : 'no runner-up'
                  }
                  bar={current.confidence}
                />
                <Meter
                  label="reach"
                  value={current.impact.toLocaleString()}
                  note={current.impactUnit}
                />
                <Meter
                  label="by hand"
                  value={current.effort + ' min'}
                  note={current.sweep ? 'across ' + current.sweep.count + ' issues' : 'for this one'}
                />
                <Meter
                  label="dead end"
                  value={percent(current.deadEnd)}
                  note="chance it closes with no fix"
                  bar={current.deadEnd}
                />
              </div>

              <Section
                title={current.sweep ? 'Spot-check the set' : 'The issues'}
                aside={
                  current.sweep ? (
                    <span style={{ fontSize: 11 }}>{current.sweep.basis}</span>
                  ) : null
                }
              >
                <IssueTable
                  issues={current.issues}
                  total={current.sweep?.count ?? current.issues.length}
                  canonical={
                    current.kind === 'dedupe'
                      ? Number(current.id.replace('dup-', ''))
                      : undefined
                  }
                />
              </Section>

              <Section title="How it was ranked">
                <div className="rows">
                  {current.explain.map((line, index) => (
                    <div className="signal" key={index}>
                      <div className="signalEvidence" style={{ gridColumn: '1 / -1' }}>
                        {line}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            </article>
          )}

          {applied.length > 0 ? (
            <Section title={'Applied this session · ' + applied.length}>
              <div className="pane">
                {applied.slice(0, 6).map((entry, index) => (
                  <div className="listRow" key={entry.caseId + index}>
                    <span className="listKind">
                      {entry.automatic ? 'automatic' : 'approved'}
                    </span>
                    <span>{entry.headline}</span>
                    <span className="listWhy">{countOf(entry.requests, 'request')}</span>
                  </div>
                ))}
              </div>
            </Section>
          ) : null}
        </div>
      </main>

      <footer className="bottombar">
        {current ? (
          <>
            <span>
              <kbd>⏎</kbd> apply
            </span>
            <span>
              <kbd>e</kbd> edit
            </span>
            <span>
              <kbd>r</kbd> it&rsquo;s wrong
            </span>
            <span>
              <kbd>s</kbd> later
            </span>
            <span className="sep">·</span>
            <span>
              <kbd>j</kbd>
              <kbd>k</kbd> move
            </span>
          </>
        ) : null}
        <span className="sep">·</span>
        <span>
          <kbd>\</kbd> what this replaces
        </span>
        <span>
          <kbd>?</kbd> what you&rsquo;re not seeing
        </span>
        <span>
          <kbd>i</kbd> how it decides
        </span>
        <span className="grow" />
        <span>
          {stats.issuesCovered.toLocaleString()} covered · {stats.issuesWithheld.toLocaleString()} withheld ·{' '}
          {Math.round(stats.minutesOfWork / 60)}h of manual work represented
        </span>
      </footer>

      {overlay === 'compare' ? (
        <Compare data={data} current={current} onClose={() => setOverlay(null)} />
      ) : null}
      {overlay === 'suppressed' ? (
        <Suppressed data={data} onClose={() => setOverlay(null)} />
      ) : null}
      {overlay === 'models' ? <ModelCard data={data} onClose={() => setOverlay(null)} /> : null}
    </div>
  )
}

function SignalLine({ signal }: { signal: DocketResponse['cases'][number]['signals'][number] }) {
  const push = signal.push
  const cls = push === undefined ? 'flat' : push > 0.01 ? 'for' : push < -0.01 ? 'against' : 'flat'
  return (
    <div className="signal">
      <div className="signalLabel">{signal.label}</div>
      <div className={'push ' + cls} title={signal.weight !== undefined ? 'weight ' + signal.weight : undefined}>
        {push === undefined
          ? percent(signal.value * signal.confidence)
          : (push > 0 ? '+' : '') + push.toFixed(2)}
      </div>
      <div className="signalEvidence">{signal.evidence}</div>
    </div>
  )
}

/**
 * What the last correction changed.
 *
 * The reordering is shown by name, not as a number. "#74147 moved from 2nd to
 * 9th" is something an operator can check against their own judgment; "queue
 * updated" is something they have to take on faith, and taking a ranking on
 * faith is how people stop correcting it.
 */
function Changed({ change, cases }: { change: ChangeNote; cases: WireCase[] }) {
  const moved: string[] = []
  const nowIndex = new Map(cases.map((c, index) => [c.id, index]))

  change.before.forEach((entry, wasIndex) => {
    const isIndex = nowIndex.get(entry.id)
    if (isIndex === undefined) return
    if (isIndex !== wasIndex) {
      moved.push(
        entry.headline.slice(0, 64) + ' · ' + (wasIndex + 1) + ' → ' + (isIndex + 1),
      )
    }
  })

  return (
    <div className="changed">
      <div className="changedTitle">what that changed</div>
      {change.summary.map((line, index) => (
        <div className="changedLine" key={index}>
          {line}
        </div>
      ))}
      {change.adjustments.map((adjust, index) => (
        <div className="adjust" key={index}>
          <span className="adjustTarget">{adjust.target}</span>
          <span className="was">×{adjust.from.toFixed(2)}</span>
          <span className="arrow">→</span>
          <span className="now">×{adjust.to.toFixed(2)}</span>
          <span>{adjust.note}</span>
        </div>
      ))}
      {moved.length > 0 ? (
        <>
          <div className="changedTitle" style={{ marginTop: 10 }}>
            reordered
          </div>
          {moved.map((line, index) => (
            <div className="adjust" key={index}>
              {line}
            </div>
          ))}
        </>
      ) : change.adjustments.length > 0 ? (
        <div className="adjust">the order held: nothing else was close enough to move</div>
      ) : null}
    </div>
  )
}
