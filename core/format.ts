/** Small shared formatters. Defined once so the units never disagree. */

export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? singular + 's')
}

export function countOf(count: number, singular: string, pluralForm?: string): string {
  return count + ' ' + plural(count, singular, pluralForm)
}

/** "812 days" / "14 months" / "2.3 years" -- whichever reads more naturally. */
export function duration(days: number): string {
  if (days < 45) return countOf(days, 'day')
  if (days < 730) return countOf(Math.round(days / 30), 'month')
  return (days / 365).toFixed(1) + ' years'
}

export function shortDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10)
}

export function percent(value: number, digits = 0): string {
  return (value * 100).toFixed(digits) + '%'
}

export function issueRef(numbers: number[], limit = 4): string {
  const shown = numbers.slice(0, limit).map((n) => '#' + n)
  const extra = numbers.length - shown.length
  return shown.join(', ') + (extra > 0 ? ' and ' + extra + ' more' : '')
}

export function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes + ':' + String(rest).padStart(2, '0')
}

/** Human names for the decision kinds. The interface never shows raw ids. */
export const KIND_LABEL: Record<string, string> = {
  dedupe: 'Duplicate set',
  needs_repro: 'Needs a reproduction',
  verify_canary: 'Retest on canary',
  stale_close: 'Close as stale',
  accepted_route: 'Route to a team',
  escalate: 'Escalate',
}

export const REASON_LABEL: Record<string, string> = {
  wrong_situation: 'Read it wrong',
  wrong_action: 'Wrong response',
  wrong_priority: 'Not now',
  not_my_area: 'Not my area',
  stale_evidence: 'Evidence expired',
}
