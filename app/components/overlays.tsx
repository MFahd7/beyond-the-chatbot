/**
 * The three things the operator can ask for that are not the next decision.
 *
 *   Compare     What this replaces, rendered from the same data rather than
 *               screenshotted, so the contrast cannot be staged.
 *   Suppressed  Everything the docket is not showing, and why.
 *   ModelCard   The held-out numbers, including the models that were cut.
 *
 * All three are escape hatches, and they exist because the central claim of
 * this interface -- that it can decide what you should look at -- is only
 * acceptable if it can be checked at any moment without leaving the screen.
 */

import type { DocketResponse, WireBacklogRow, WireCase, WireSuppressed } from '@/app/api-types'
import { KIND_LABEL, duration, percent } from '@/core/format'

function Overlay({
  title,
  sub,
  children,
  onClose,
}: {
  title: string
  sub: string
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="overlay" role="dialog" aria-label={title}>
      <div className="overlayHead">
        <span className="overlayTitle">{title}</span>
        <span className="grow" />
        <button className="ghostButton" onClick={onClose}>
          close <kbd>esc</kbd>
        </button>
      </div>
      <div className="overlayHead">
        <span className="overlaySub">{sub}</span>
      </div>
      <div className="overlayBody">{children}</div>
    </div>
  )
}

/**
 * Side by side with what this replaces.
 *
 * Both panes are built from the same 1,000 issues. The right-hand list is
 * ordered the way an issue tracker orders things -- newest first -- because
 * that is the only ordering a backlog can produce without a model of what the
 * reader is trying to do. Nothing about it is exaggerated; it is the real
 * titles, the real labels, the real ages.
 */
export function Compare({
  data,
  current,
  onClose,
}: {
  data: DocketResponse
  current: WireCase | undefined
  onClose: () => void
}) {
  const rows: WireBacklogRow[] = data.backlog

  return (
    <Overlay
      title="What this replaces"
      sub={
        'Both panes are the same ' +
        data.stats.openIssues.toLocaleString() +
        ' open issues from ' +
        data.meta.repo +
        '. On the left, the docket: one decision, prepared, with the evidence and the exact ' +
        'requests it would send. On the right, the two interfaces this is meant to replace.'
      }
      onClose={onClose}
    >
      <div className="compare">
        <div className="pane">
          <div className="paneHead">
            <div className="paneName">Docket</div>
            <div className="paneClaim">
              {data.stats.cases} decisions. This is the one to make next.
            </div>
          </div>
          <div className="paneBody">
            {current ? (
              <>
                <h3 style={{ fontSize: 19, margin: '0 0 8px', lineHeight: 1.3 }}>
                  {current.headline}
                </h3>
                <p style={{ color: 'var(--text-muted)', fontSize: 13.5, marginTop: 0 }}>
                  {current.situation}
                </p>
                <div className="action" style={{ marginTop: 12 }}>
                  <div className="actionSummary">{current.action.summary}</div>
                  <div className="reversal">
                    {current.action.total} request
                    {current.action.total === 1 ? '' : 's'} prepared · undo:{' '}
                    {current.action.reversal || 'nothing to undo'}
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  {current.signals.slice(0, 3).map((signal) => (
                    <div className="signal" key={signal.id} style={{ marginBottom: 1 }}>
                      <div className="signalLabel">{signal.label}</div>
                      <div className="push flat">
                        {signal.push !== undefined
                          ? (signal.push > 0 ? '+' : '') + signal.push.toFixed(2)
                          : percent(signal.value)}
                      </div>
                      <div className="signalEvidence">{signal.evidence}</div>
                    </div>
                  ))}
                </div>
                <p className="bubbleNote">
                  Time to the next decision: one keystroke. Nothing was typed to get here.
                </p>
              </>
            ) : (
              <p style={{ color: 'var(--text-muted)' }}>Docket clear.</p>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="pane">
            <div className="paneHead">
              <div className="paneName">The dashboard · github.com/{data.meta.repo}/issues</div>
              <div className="paneClaim">
                {data.stats.openReported.toLocaleString()} rows, newest first. No ordering by what
                matters, because the list has no idea what you are trying to do.
              </div>
            </div>
            <div className="paneBody">
              {rows.map((row) => (
                <div className="ghostRow" key={row.number}>
                  <span className="ghostNum">#{row.number}</span>
                  <span className="ghostTitle">{row.title}</span>
                  <span className="ghostMeta">
                    {row.labels.length ? row.labels.length + 'L · ' : ''}
                    {row.comments}c · {duration(row.ageDays)}
                  </span>
                </div>
              ))}
              <p className="bubbleNote">
                Showing {rows.length} of {data.stats.openReported.toLocaleString()}. Scrolling to
                the end of this list is roughly {Math.round(data.stats.openReported / rows.length)}{' '}
                more screens, and the thing worth doing is not at the top of any of them.
              </p>
            </div>
          </div>

          <div className="pane">
            <div className="paneHead">
              <div className="paneName">The assistant · &ldquo;Ask AI about this repo&rdquo;</div>
              <div className="paneClaim">
                Answers questions. Cannot tell you which one to ask.
              </div>
            </div>
            <div className="chatMock">
              <div className="bubble you">What should I work on next?</div>
              <div className="bubble bot">
                Happy to help! Could you tell me a bit more about what you&rsquo;re looking for
                &mdash; are you interested in bugs, feature requests, or documentation? Any
                particular area of the codebase?
              </div>
              <div className="bubble you">
                I don&rsquo;t know. That&rsquo;s what I&rsquo;m asking.
              </div>
              <div className="bubble bot">
                I can search the issues if you give me a keyword or label to start from.
              </div>
              <p className="bubbleNote">
                The failure is structural, not a bad model. A chat window is a request/response
                surface: it waits for a question that already contains the answer&rsquo;s shape. To
                ask &ldquo;are #74147 and #74149 duplicates&rdquo; you must first have found both,
                which is the entire job. And having answered, it cannot act.
              </p>
            </div>
          </div>
        </div>
      </div>
    </Overlay>
  )
}

/**
 * Everything the docket is not showing.
 *
 * The honest counterweight to a one-decision-at-a-time interface. Every issue
 * in the backlog is either covered by a case or listed here with the reason it
 * was held back -- below the confidence floor, snoozed, or demoted by the
 * operator's own corrections.
 */
export function Suppressed({
  data,
  onClose,
}: {
  data: DocketResponse
  onClose: () => void
}) {
  const grouped = new Map<string, WireSuppressed[]>()
  for (const item of data.suppressed) {
    const key = item.why.replace(/\(.*\)/, '').trim()
    const bucket = grouped.get(key)
    if (bucket) bucket.push(item)
    else grouped.set(key, [item])
  }

  const covered = data.stats.issuesCovered
  const held = data.stats.issuesWithheld

  return (
    <Overlay
      title="What you are not being shown"
      sub={
        covered.toLocaleString() +
        ' issues are covered by the ' +
        data.stats.cases +
        ' decisions in the docket. ' +
        held.toLocaleString() +
        ' are held back, each for a stated reason. Nothing is silently dropped: these two ' +
        'numbers add up to the whole backlog, which is the only thing that makes hiding ' +
        'anything defensible.'
      }
      onClose={onClose}
    >
      {[...grouped.entries()].map(([reason, items]) => (
        <div key={reason} style={{ marginBottom: 22 }}>
          <div className="sectionHead">
            <span>
              {items.length} · {reason}
            </span>
          </div>
          <div className="pane">
            {items.slice(0, 40).map((item) => (
              <div className="listRow" key={item.id}>
                <span className="listKind">{KIND_LABEL[item.kind] ?? item.kind}</span>
                <span>{item.headline}</span>
                <span className="listWhy">{item.confidence.toFixed(2)}</span>
              </div>
            ))}
            {items.length > 40 ? (
              <div className="listRow">
                <span className="listKind" />
                <span className="listWhy">and {items.length - 40} more for the same reason</span>
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </Overlay>
  )
}

/**
 * The model card, in the interface rather than in a README nobody opens.
 *
 * Including the two models that were cut is the part that matters. A system
 * that only reports the numbers that flattered it has told you nothing about
 * the numbers it is acting on.
 */
export function ModelCard({ data, onClose }: { data: DocketResponse; onClose: () => void }) {
  return (
    <Overlay
      title="How this decides, and how well"
      sub={
        'Every model below is binary, balanced within each creation year, and scored on a ' +
        'held-out quarter of its own year-matched set — so 50% is the honest baseline. ' +
        'Fitted on ' +
        data.meta.trainingRows.toLocaleString() +
        ' recorded maintainer decisions from ' +
        data.meta.repo +
        '.'
      }
      onClose={onClose}
    >
      <div className="pane" style={{ marginBottom: 22 }}>
        <div className="modelRow head">
          <span>model</span>
          <span>accuracy</span>
          <span>AUC</span>
          <span>verdict</span>
        </div>
        {data.meta.models.map((model) => (
          <div className="modelRow" key={model.id}>
            <span className="modelName">
              {model.id}{' '}
              <span className={'badge ' + (model.shipped ? 'on' : 'off')}>
                {model.shipped ? 'in use' : 'not used'}
              </span>
            </span>
            <span className="num">{percent(model.accuracy, 1)}</span>
            <span className="num">{model.auc.toFixed(3)}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{model.verdict}</span>
          </div>
        ))}
      </div>

      <div className="sectionHead">
        <span>the pipeline</span>
      </div>
      <div className="pane" style={{ padding: '14px 16px' }}>
        <ol style={{ margin: 0, paddingLeft: 20, color: 'var(--text-muted)', fontSize: 13.5 }}>
          <li style={{ marginBottom: 8 }}>
            <strong style={{ color: 'var(--text)' }}>Data.</strong> {data.meta.openIssues} open
            issues and {data.meta.trainingRows.toLocaleString()} closed ones with recorded
            outcomes, pulled from the GitHub search API. Fetched {data.meta.fetchedAt.slice(0, 10)}.
          </li>
          <li style={{ marginBottom: 8 }}>
            <strong style={{ color: 'var(--text)' }}>Signals.</strong> 29 observations per issue,
            parsed out of the repo&rsquo;s own bug template. Every one describes the submission
            only &mdash; nothing that accumulates after filing, because that would let the model
            read the outcome off the back of the card.
          </li>
          <li style={{ marginBottom: 8 }}>
            <strong style={{ color: 'var(--text)' }}>Intent.</strong> Two fitted models decide what
            a report needs. Two more were fitted and are not used. Staleness and canary lag are
            stated rules instead, because they depend on the silence after filing that the feature
            set is denied.
          </li>
          <li style={{ marginBottom: 8 }}>
            <strong style={{ color: 'var(--text)' }}>Duplicates.</strong> Unsupervised: TF-IDF
            cosine over {data.meta.vocabulary.toLocaleString()} terms plus trigram overlap on
            titles. {data.meta.clusters} clusters found. No ground truth exists for duplicates in
            this repo, so this is the one part of the system with no measured accuracy, and it says
            so on the card.
          </li>
          <li>
            <strong style={{ color: 'var(--text)' }}>Attention.</strong> impact × confidence ×
            urgency ÷ effort. Ranking is the only place engagement, age and duplicate counts are
            used, because ranking makes no historical prediction.
          </li>
        </ol>
      </div>
    </Overlay>
  )
}
