import type { ReviewSummary, Thread } from '../../protocol.js'
import { describe, expect, it } from 'vitest'
import type { FileView } from './pages.js'
import { foldKey, parseFolds, reviewPage } from './review-page.js'

const SOURCE = 'src-1'
const REVIEW = 'rev-1'

function summary(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    reviewId: REVIEW,
    title: 'a change',
    status: 'open',
    url: `http://127.0.0.1:7777/r/${REVIEW}`,
    createdAt: 0,
    lastActivityAt: 0,
    ageSeconds: 0,
    snapshotSeq: 1,
    filesChanged: 1,
    threadsAwaitingAgent: 0,
    threadsAwaitingHuman: 0,
    sources: [
      {
        id: SOURCE,
        label: 'repo',
        rootPath: '/tmp/repo',
        vcs: 'git',
        baseRef: 'HEAD',
        approved: false,
      },
    ],
    ...overrides,
  }
}

function file(path: string): FileView {
  return {
    changeId: `c-${path}`,
    sourceLabel: 'repo',
    sourceId: SOURCE,
    path,
    changeType: 'modified',
    isBinary: false,
    truncated: false,
    oldText: 'const a = 1\n',
    newText: 'const a = 2\n',
  }
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't-1',
    sourceId: SOURCE,
    sourceLabel: 'repo',
    path: 'src/a.ts',
    side: 'new',
    line: 1,
    anchorLine: 'const a = 2',
    state: 'active',
    origin: 'human',
    turn: 'agent',
    drifted: false,
    messages: [
      { id: 'm-1', seq: 1, author: 'human', body: 'rename this', createdAt: 0, submittedAt: 1 },
    ],
    ...overrides,
  }
}

/** The `<details>` opening tag for one file block. */
function fileTag(markup: string, path: string): string {
  const key = foldKey(SOURCE, path)
  const match = markup.match(new RegExp(`<details class="file" data-fold="${key}"[^>]*>`))
  return match?.[0] ?? ''
}

describe('fold cookie', () => {
  it('reads back the keys it was given', () => {
    const value = [REVIEW, encodeURIComponent('src-1:a.ts'), encodeURIComponent('src-1:b.ts')].join(
      '|',
    )

    expect(parseFolds(value, REVIEW)).toEqual(new Set(['src-1:a.ts', 'src-1:b.ts']))
  })

  it('ignores a cookie left over from a different review', () => {
    const value = [`other-review`, encodeURIComponent('src-1:a.ts')].join('|')

    expect(parseFolds(value, REVIEW)).toEqual(new Set())
  })

  it('survives a path holding the separator and the escape character', () => {
    const path = 'src/odd|name%.ts'
    const key = foldKey(SOURCE, path)
    const value = [REVIEW, encodeURIComponent(key)].join('|')

    expect(parseFolds(value, REVIEW)).toEqual(new Set([key]))
  })

  it('treats a missing or malformed cookie as nothing folded', () => {
    expect(parseFolds(undefined, REVIEW)).toEqual(new Set())
    expect(parseFolds('', REVIEW)).toEqual(new Set())
    expect(parseFolds(`${REVIEW}|%zz`, REVIEW)).toEqual(new Set())
  })
})

describe('file folding', () => {
  it('expands a file the reviewer has not collapsed', () => {
    const markup = reviewPage(summary(), [file('src/a.ts')], []).value

    expect(fileTag(markup, 'src/a.ts')).toContain('open')
  })

  it('leaves a collapsed file collapsed across a render', () => {
    const folded = new Set([foldKey(SOURCE, 'src/a.ts')])
    const markup = reviewPage(
      summary(),
      [file('src/a.ts'), file('src/b.ts')],
      [],
      undefined,
      'split',
      folded,
    ).value

    expect(fileTag(markup, 'src/a.ts')).not.toContain('open')
    expect(fileTag(markup, 'src/b.ts')).toContain('open')
  })

  it('expands a collapsed file that holds the open comment box', () => {
    const folded = new Set([foldKey(SOURCE, 'src/a.ts')])
    const box = { sourceId: SOURCE, path: 'src/a.ts', side: 'new' as const, line: 1 }
    const markup = reviewPage(summary(), [file('src/a.ts')], [], box, 'split', folded).value

    expect(fileTag(markup, 'src/a.ts')).toContain('open')
  })
})

// A blank half carries `empty`, and the page-level "nothing here" message used
// to carry the same name. The generic rule's 2.5rem of padding then landed on
// every added and removed line, which is invisible stacked and triples the row
// height side by side. The two names have to stay apart.
describe('blank diff halves against the empty-state message', () => {
  const added = (): FileView => ({ ...file('src/a.ts'), oldText: 'a\n', newText: 'a\nb\n' })

  it('gives a blank half a name the page-level message does not share', () => {
    const markup = reviewPage(summary(), [added()], []).value

    expect(markup).toMatch(/class="side (left|right) empty"/)
    expect(markup).not.toContain('class="side left emptystate"')
  })

  it('names the empty-state message so no diff half can match it', () => {
    const markup = reviewPage(summary(), [], []).value

    expect(markup).toContain('<p class="emptystate">')
  })

  it('ships no bare .empty rule for a diff half to pick up', () => {
    const markup = reviewPage(summary(), [added()], []).value

    expect(markup).toMatch(/\.emptystate\s*\{/)
    expect(markup).not.toMatch(/[\n;{}]\s*\.empty\s*\{/)
  })
})

describe('reply box', () => {
  it('starts closed, so a thread reads as read rather than owed', () => {
    const markup = reviewPage(summary(), [file('src/a.ts')], [thread()]).value

    expect(markup).toContain('<details class="reply">')
    expect(markup).not.toContain('<details class="reply" open>')
  })

  it('keeps resolve reachable without opening the reply box', () => {
    const markup = reviewPage(summary(), [file('src/a.ts')], [thread()]).value
    const reply = markup.indexOf('<details class="reply">')
    const resolve = markup.indexOf(`/threads/t-1/resolve`)

    expect(resolve).toBeGreaterThan(-1)
    expect(resolve).toBeGreaterThan(markup.indexOf('</details>', reply))
  })

  it('offers reopen instead of resolve on a resolved thread', () => {
    const markup = reviewPage(summary(), [file('src/a.ts')], [thread({ state: 'resolved' })]).value

    expect(markup).toContain('/threads/t-1/reopen')
    expect(markup).not.toContain('/threads/t-1/resolve')
  })
})

describe('submit bar after approval', () => {
  const approved = () =>
    summary({
      status: 'approved',
      sources: [{ ...summary().sources[0]!, approved: true }],
    })

  it('drops the approve button once the review is approved', () => {
    const markup = reviewPage(approved(), [file('src/a.ts')], []).value

    expect(markup).not.toContain('value="approved"')
    expect(markup).toContain('Waiting for the agent to commit')
    expect(markup).toContain(`/r/${REVIEW}/unapprove`)
  })

  it('drops request-changes too, leaving one way back', () => {
    const markup = reviewPage(approved(), [file('src/a.ts')], []).value

    expect(markup).not.toContain('value="changes_requested"')
  })

  it('still offers both verdicts before approval', () => {
    const markup = reviewPage(summary(), [file('src/a.ts')], []).value

    expect(markup).toContain('value="approved"')
    expect(markup).toContain('value="changes_requested"')
    expect(markup).not.toContain(`/r/${REVIEW}/unapprove`)
  })

  it('says what sending notes on an approved review costs', () => {
    const draft = thread({
      messages: [
        { id: 'm-2', seq: 1, author: 'human', body: 'one more', createdAt: 0, submittedAt: null },
      ],
    })
    const markup = reviewPage(approved(), [file('src/a.ts')], [draft]).value

    expect(markup).toContain('Sending them takes the approval back')
    expect(markup).toContain('value="comment"')
  })
})
