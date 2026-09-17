/**
 * Draft the thing that will actually happen.
 *
 * Every mutation below is a real GitHub REST call against real label names
 * from the repo's own taxonomy, written out in full so the operator reviews
 * the request rather than a description of it. "Label as needs-repro" is a
 * promise; `POST /repos/vercel/next.js/issues/92888/labels {"labels":["please
 * add a complete reproduction"]}` is a thing you can check.
 *
 * WHAT RUNS, AND WHAT DOES NOT
 *
 * By default nothing is sent. Approving a case commits it to a local mutation
 * log and moves the interface on. This is a deliberate choice rather than a
 * missing feature: the corpus is someone else's bug tracker, and a demo has no
 * business writing comments on 1,000 open issues that real people are waiting
 * on. Set GITHUB_WRITE_TOKEN and DOCKET_TARGET_REPO to a repository you own
 * and the same drafts execute for real against that repo.
 *
 * The review model is the same either way, which is the point: the operator
 * approves the exact request, and the log records what was approved, by whom,
 * and what it would take to undo.
 */

import type { CaseKind, DraftAction, Issue, Mutation } from './types'
import { teamFor } from './templates'

const REPO = 'vercel/next.js'

function labelCall(issue: number, labels: string[], stage: Mutation['stage'] = 'review'): Mutation {
  return {
    kind: 'label',
    issue,
    payload: labels.join(', '),
    stage,
    request:
      'POST /repos/' +
      REPO +
      '/issues/' +
      issue +
      '/labels  ' +
      JSON.stringify({ labels }),
  }
}

function commentCall(issue: number, body: string): Mutation {
  return {
    kind: 'comment',
    issue,
    payload: body,
    // Never 'auto'. See the note on Mutation.stage.
    stage: 'review',
    request:
      'POST /repos/' + REPO + '/issues/' + issue + '/comments  ' + JSON.stringify({ body }),
  }
}

function closeCall(issue: number, reason: 'completed' | 'not_planned'): Mutation {
  return {
    kind: 'close',
    issue,
    payload: reason,
    stage: 'review',
    request:
      'PATCH /repos/' +
      REPO +
      '/issues/' +
      issue +
      '  ' +
      JSON.stringify({ state: 'closed', state_reason: reason }),
  }
}

/**
 * Reversibility, per mutation kind.
 *
 * A label goes on and comes off and nobody remembers. A close reopens. A
 * comment is the one that does not really come back: it arrives in the inbox
 * of everyone subscribed to the issue the moment it posts, and deleting it
 * afterwards does not unsend the email. So any draft containing a comment is
 * capped there, and the interface says so on the card rather than describing
 * every action as undoable.
 */
export const REVERSIBILITY: Record<Mutation['kind'], number> = {
  label: 0.97,
  unlabel: 0.97,
  milestone: 0.95,
  assign: 0.95,
  close: 0.85,
  comment: 0.4,
}

function reversibilityOf(mutations: Mutation[]): { score: number; note: string } {
  if (mutations.length === 0) return { score: 1, note: 'nothing to undo' }
  const worst = mutations.reduce(
    (low, m) => Math.min(low, REVERSIBILITY[m.kind]),
    1,
  )
  const hasComment = mutations.some((m) => m.kind === 'comment')
  const closes = mutations.filter((m) => m.kind === 'close').length

  const parts: string[] = []
  if (closes > 0) parts.push('reopen ' + closes + ' issue(s)')
  const labels = mutations.filter((m) => m.kind === 'label').length
  if (labels > 0) parts.push('remove ' + labels + ' label(s)')
  if (hasComment) {
    parts.push(
      'delete ' +
        mutations.filter((m) => m.kind === 'comment').length +
        ' comment(s), though subscribers were already emailed',
    )
  }
  return { score: worst, note: parts.join('; ') }
}

interface DraftInput {
  kind: CaseKind
  issues: Issue[]
  /** Needed to decide whether the reversible half may apply itself. */
  confidence?: number
  canonical?: Issue
  areas: string[]
  /** For the canary ask: how far behind, and what is current. */
  linesBehind?: number
  currentVersion?: string
  idleDays?: number
}

export function draftAction(input: DraftInput): DraftAction {
  const mutations: Mutation[] = []
  let summary = ''

  switch (input.kind) {
    case 'dedupe': {
      const canonical = input.canonical ?? (input.issues[0] as Issue)
      const duplicates = input.issues.filter((i) => i.number !== canonical.number)

      for (const duplicate of duplicates) {
        mutations.push(
          commentCall(
            duplicate.number,
            'Closing as a duplicate of #' +
              canonical.number +
              ', which has the fuller reproduction. Everything here is tracked there ' +
              '— please subscribe to #' +
              canonical.number +
              ' for updates, and reopen this if you believe it is a different bug.',
          ),
        )
        mutations.push(closeCall(duplicate.number, 'not_planned'))
      }

      mutations.push(
        commentCall(
          canonical.number,
          'Consolidating duplicate reports into this issue: ' +
            duplicates.map((d) => '#' + d.number).join(', ') +
            '. Keeping this one as it has the most complete reproduction.',
        ),
      )

      summary =
        'Keep #' +
        canonical.number +
        ' as canonical, close ' +
        duplicates.length +
        ' duplicate(s) with a pointer comment, and record the consolidation on the canonical issue.'
      break
    }

    case 'needs_repro': {
      const issue = input.issues[0] as Issue
      // The one autonomous mutation in the system. A label, on the decision
      // with the best-measured model, that comes off without a trace.
      mutations.push(
        labelCall(
          issue.number,
          ['please add a complete reproduction'],
          (input.confidence ?? 0) >= AUTO_CONFIDENCE ? 'auto' : 'review',
        ),
      )
      mutations.push(
        commentCall(
          issue.number,
          'Thanks for the report. There is not enough here to reproduce the problem, so ' +
            'nobody can start on it yet — a minimal repository or sandbox that shows the ' +
            'behaviour would unblock it. https://github.com/vercel/next.js/tree/canary/examples/reproduction-template ' +
            'is a good starting point. Happy to reopen the moment there is something to run.',
        ),
      )
      summary =
        'Label #' +
        issue.number +
        ' as needing a reproduction and post the ask, using the repo’s own wording.'
      break
    }

    case 'verify_canary': {
      const issue = input.issues[0] as Issue
      mutations.push(labelCall(issue.number, ['please verify canary']))
      mutations.push(
        commentCall(
          issue.number,
          'This was reported against a version that is now ' +
            (input.linesBehind ?? 0) +
            ' minor release lines behind (current: ' +
            (input.currentVersion ?? 'canary') +
            '). A good deal has changed in between and this may already be fixed. ' +
            'Could you try `next@canary` and let us know whether it still happens?',
        ),
      )
      summary =
        'Ask #' +
        issue.number +
        ' to retest on canary, since ' +
        (input.linesBehind ?? 0) +
        ' release lines have shipped since their version.'
      break
    }

    case 'stale_close': {
      const issue = input.issues[0] as Issue
      mutations.push(labelCall(issue.number, ['stale']))
      mutations.push(
        commentCall(
          issue.number,
          'Closing this as stale: no activity for ' +
            (input.idleDays ?? 0) +
            ' days and no reproduction to work from. This is housekeeping rather than a ' +
            'judgement about the bug — if it is still happening, reopening with a ' +
            'reproduction on a current version is genuinely welcome.',
        ),
      )
      mutations.push(closeCall(issue.number, 'not_planned'))
      summary =
        'Close #' +
        issue.number +
        ' as stale after ' +
        (input.idleDays ?? 0) +
        ' silent days, leaving the door open.'
      break
    }

    case 'accepted_route':
    case 'escalate': {
      const issue = input.issues[0] as Issue
      const team = teamFor(input.areas)
      const labels = [...input.areas, 'linear: ' + team]
      mutations.push(labelCall(issue.number, labels))

      if (input.kind === 'escalate') {
        mutations.push(
          commentCall(
            issue.number,
            'Confirmed and routed to the ' +
              team +
              ' team. Flagging this one as higher priority than the queue position ' +
              'suggests, given how many people are hitting it.',
          ),
        )
        summary =
          'Route #' +
          issue.number +
          ' to the ' +
          team +
          ' team with area labels, and flag it above the queue.'
      } else {
        summary =
          'Accept #' +
          issue.number +
          ' as a real defect: apply ' +
          labels.join(' + ') +
          ' and route it to the ' +
          team +
          ' team.'
      }
      break
    }
  }

  const reversal = reversibilityOf(mutations)
  const autonomous = mutations.filter((m) => m.stage === 'auto')
  return {
    summary,
    mutations,
    reversal: reversal.note,
    reversibility: reversal.score,
    autonomous,
  }
}

/**
 * Which drafts are allowed to apply themselves, and on what delay.
 *
 * Only one kind qualifies: labelling an issue that needs a reproduction. It is
 * the highest-volume decision in the backlog, the model that covers it is the
 * better of the two, and a label is the one mutation that comes off cleanly.
 * Everything with a `close` or a comment in it waits for a person, regardless
 * of how confident the model is, because confidence is not the same as
 * permission.
 *
 * The delay exists so the operator can watch it happen and stop it. An
 * autonomous action nobody can see coming is indistinguishable from a bug.
 */
export const AUTO_CONFIDENCE = 0.7

/** Seconds before the autonomous half applies, or null if nothing may. */
export function autoApplyAfter(action: DraftAction, confidence: number): number | null {
  if (action.autonomous.length === 0) return null
  if (confidence < AUTO_CONFIDENCE) return null
  // Every autonomous mutation must clear the reversibility bar on its own.
  const reversible = action.autonomous.every((m) => REVERSIBILITY[m.kind] >= 0.9)
  if (!reversible) return null
  return 45
}
