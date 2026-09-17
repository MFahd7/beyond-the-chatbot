import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { Corpus, EvalReport, Issue, Weights } from '@/core/types'

const DATA = path.join(process.cwd(), 'data')

function read<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(DATA, file), 'utf8')) as T
}

let corpusCache: Corpus | null = null

/** The committed corpus. Real data, so the tests assert against real data. */
export function corpus(): Corpus {
  if (!corpusCache) corpusCache = read<Corpus>('corpus.json')
  return corpusCache
}

export function weights(): Weights {
  return read<Weights>('weights.json')
}

export function evaluation(): EvalReport {
  return read<EvalReport>('eval.json')
}

/** The clock the corpus was built against, so age assertions stay fixed. */
export function builtAt(): Date {
  return new Date(corpus().meta.builtAt)
}

/** A synthetic issue, for tests that need to control one field at a time. */
export function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1000,
    title: 'Something is broken in the router',
    body: 'It breaks when I navigate.',
    state: 'open',
    stateReason: null,
    labels: [],
    createdAt: '2026-01-15T00:00:00Z',
    updatedAt: '2026-01-20T00:00:00Z',
    closedAt: null,
    comments: 0,
    reactions: 0,
    author: 'someone',
    authorAssociation: 'NONE',
    assignees: [],
    milestone: null,
    locked: false,
    url: 'https://github.com/vercel/next.js/issues/1000',
    ...overrides,
  }
}

/** A filled-in bug report in the repo's current template. */
export function report(fields: {
  repro?: string
  version?: string
  areas?: string
  steps?: string
  extra?: string
}): string {
  return [
    '### Link to the code that reproduces this issue',
    '',
    fields.repro ?? '_No response_',
    '',
    '### To Reproduce',
    '',
    fields.steps ?? '1. run it\n2. watch it break\n3. observe the error',
    '',
    '### Current vs. Expected behavior',
    '',
    'It throws. It should not throw.',
    '',
    '### Provide environment information',
    '',
    '```bash',
    'Operating System:',
    '  Platform: linux',
    'Binaries:',
    '  Node: 20.11.0',
    'Relevant Packages:',
    '  next: ' + (fields.version ?? '15.0.0'),
    '```',
    '',
    '### Which area(s) are affected? (Select all that apply)',
    '',
    fields.areas ?? 'Turbopack',
    '',
    '### Additional context',
    '',
    fields.extra ?? '_No response_',
  ].join('\n')
}
