import type { ReviewSummary, Thread } from '../../protocol.js'
import { describe, expect, it } from 'vitest'
import type { FileView } from './pages.js'
import { foldKey, parseFolds, parseOpenBox, parseRail, reviewPage } from './review-page.js'

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
    endLine: null,
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
  // Matched by the fold key wherever it sits in the tag, rather than by the
  // exact order of attributes, which is not what any of these tests are about.
  const key = foldKey(SOURCE, path)
  const match = markup.match(new RegExp(`<details [^>]*data-fold="${key}"[^>]*>`))
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

/**
 * Reported from the page rather than found in a test: one comment drawn twice.
 *
 * An insertion pushes the new-side numbering ahead of the old. While both
 * columns of a context row claimed the new side, a comment on new line 2
 * matched the inserted row and the context row whose old number was 2, so the
 * page rendered it in both places.
 */
describe('a comment near an insertion', () => {
  const inserted = (): FileView => ({
    ...file('src/a.ts'),
    oldText: 'a\nb\nc\n',
    newText: 'a\nINSERTED\nb\nc\n',
  })

  const at = (side: 'old' | 'new', line: number) =>
    thread({ side, line, anchorLine: side === 'new' && line === 2 ? 'INSERTED' : 'b' })

  const count = (markup: string, id: string) =>
    markup.split(`id="t-${id}"`).length - 1

  it('draws it once', () => {
    const markup = reviewPage(summary(), [inserted()], [at('new', 2)]).value

    expect(count(markup, 't-1')).toBe(1)
  })

  it('draws a comment on the old side once too', () => {
    const markup = reviewPage(summary(), [inserted()], [at('old', 2)]).value

    expect(count(markup, 't-1')).toBe(1)
  })

  // The guard that used to stop the double render dropped the right half of
  // every context row, so this comment would have vanished from the page.
  it('still draws a comment on the new side of a context line', () => {
    const markup = reviewPage(summary(), [inserted()], [at('new', 3)]).value

    expect(count(markup, 't-1')).toBe(1)
  })
})

/**
 * Choosing a range is two taps: the line it starts on, then the line it ends
 * on. Both are ordinary links, so it works before any script runs and needs
 * neither a drag nor a modifier key — neither of which a phone has.
 */
describe('selecting a range', () => {
  const many = (): FileView => ({
    ...file('src/a.ts'),
    oldText: '',
    newText: 'one\ntwo\nthree\nfour\nfive\n',
  })

  const boxOn = (line: number, endLine?: number) => ({
    sourceId: SOURCE,
    path: 'src/a.ts',
    side: 'new' as const,
    line,
    endLine,
  })

  // The drag handler reads these rather than parsing hrefs back apart. Drag
  // itself is a browser behaviour and is checked in one, but a row without
  // them is a row a drag cannot reach.
  it('gives every commentable line what a drag needs', () => {
    const markup = reviewPage(summary(), [many()], []).value
    const withKey = markup.match(/data-key="[^"]+" data-line="\d+"/g) ?? []

    expect(withKey).toHaveLength(5)
    expect(markup).toContain('data-line="5"')
  })

  it('leaves a blank half out of a drag', () => {
    const markup = reviewPage(summary(), [many()], []).value
    const blanks = markup.match(/class="side left empty"[^>]*data-key/g) ?? []

    expect(blanks).toHaveLength(0)
  })

  it('offers no extend control until a box is open', () => {
    const markup = reviewPage(summary(), [many()], []).value

    expect(markup).not.toContain('addnote extend')
  })

  it('offers one on every line below the open box', () => {
    const markup = reviewPage(summary(), [many()], [], boxOn(2)).value

    // Lines 3, 4 and 5 can extend; 1 and 2 cannot.
    expect(markup.match(/addnote extend/g)).toHaveLength(3)
    expect(markup).toContain('to=5')
    expect(markup).not.toContain('to=2')
  })

  it('keeps the box on its own line while extending', () => {
    const markup = reviewPage(summary(), [many()], [], boxOn(2, 4)).value

    // The key still names line 2, so the box hangs where it was opened.
    expect(markup).toContain('name="line" value="2"')
    expect(markup).toContain('name="endLine" value="4"')
  })

  it('says what the comment will cover', () => {
    expect(reviewPage(summary(), [many()], [], boxOn(2, 4)).value).toContain('lines 2 to 4')
    expect(reviewPage(summary(), [many()], [], boxOn(2)).value).toContain('line 2')
  })

  it('sends no endLine for a one-line comment', () => {
    expect(reviewPage(summary(), [many()], [], boxOn(2)).value).not.toContain('name="endLine"')
  })

  // Counted off the class attribute rather than the word, which also appears
  // in the stylesheet this page carries.
  const shaded = (markup: string) => markup.match(/class="side [^"]*\bcovered\b/g)?.length ?? 0

  it('shades the lines being covered as they are chosen', () => {
    expect(shaded(reviewPage(summary(), [many()], [], boxOn(2, 4)).value)).toBe(3)
  })

  it('shades the lines a saved range covers', () => {
    const range = thread({ line: 2, endLine: 4, side: 'new' })

    expect(shaded(reviewPage(summary(), [many()], [range]).value)).toBe(3)
  })

  it('shades nothing for a comment on one line', () => {
    const one = thread({ line: 2, side: 'new' })

    expect(shaded(reviewPage(summary(), [many()], [one]).value)).toBe(0)
  })

  // An outdated comment is one whose code is gone, so shading lines that
  // happen to sit at those numbers now would point at the wrong thing.
  it('shades nothing for an outdated range', () => {
    const range = thread({ line: 2, endLine: 4, side: 'new', state: 'outdated' })

    expect(shaded(reviewPage(summary(), [many()], [range]).value)).toBe(0)
  })
})

describe('parsing the box out of a URL', () => {
  const key = `${SOURCE}:new:2:src/a.ts`

  it('reads a range', () => {
    expect(parseOpenBox(key, '5')).toMatchObject({ line: 2, endLine: 5 })
  })

  // Absent is null rather than undefined, matching the wire type and the
  // column, so one comment on one line reads the same everywhere.
  it('ignores an end that is not after the start', () => {
    expect(parseOpenBox(key, '2')?.endLine).toBeNull()
    expect(parseOpenBox(key, '1')?.endLine).toBeNull()
  })

  it('ignores an end that is not a number', () => {
    expect(parseOpenBox(key, 'tomorrow')?.endLine).toBeNull()
    expect(parseOpenBox(key, '')?.endLine).toBeNull()
  })
})

describe('the file tree in the rail', () => {
  const spread = (): FileView[] => [
    { ...file('src/daemon/web/layout.ts'), changeType: 'modified' },
    { ...file('src/daemon/web/tree.ts'), changeType: 'added' },
    { ...file('README.md'), changeType: 'deleted' },
  ]

  it('lists every changed file by its own name, not its path', () => {
    const markup = reviewPage(summary(), spread(), []).value

    expect(markup).toContain('>layout.ts</span>')
    expect(markup).toContain('>tree.ts</span>')
    expect(markup).toContain('>README.md</span>')
  })

  it('collapses a run of directories into one node', () => {
    const markup = reviewPage(summary(), spread(), []).value

    expect(markup).toContain('>src/daemon/web</span>')
  })

  it('links each file to its block in the diff', () => {
    const key = foldKey(SOURCE, 'src/daemon/web/tree.ts')
    const markup = reviewPage(summary(), spread(), []).value

    expect(markup).toContain(`href="#file-${key}"`)
    expect(markup).toContain(`id="file-${key}"`)
  })

  // Colour alone cannot carry the change type, so the letter does the work and
  // the colour reinforces it.
  it('names the change type rather than only colouring it', () => {
    const markup = reviewPage(summary(), spread(), []).value

    expect(markup).toContain('<span class="mark added" aria-hidden="true">A</span>')
    expect(markup).toContain('<span class="mark deleted" aria-hidden="true">D</span>')
    expect(markup).toMatch(/class="visually-hidden">\s*modified/)
  })

  it('collapses directories without a script', () => {
    const markup = reviewPage(summary(), spread(), []).value

    expect(markup).toContain('<details class="dir" open>')
  })

  // A bare number read aloud says nothing. The digit is for the eye and the
  // phrase beside it is for everyone else.
  it('counts comments as a phrase, not just a digit', () => {
    const threads = [
      thread({ id: 't-1', path: 'src/daemon/web/tree.ts' }),
      thread({ id: 't-2', path: 'src/daemon/web/tree.ts' }),
    ]
    const markup = reviewPage(summary(), spread(), threads).value

    expect(markup).toContain('<span class="count" aria-hidden="true">2</span>')
    expect(markup).toMatch(/2 comments/)
  })

  it('leaves an outdated comment out of the count', () => {
    const threads = [thread({ path: 'src/daemon/web/tree.ts', state: 'outdated' })]
    const markup = reviewPage(summary(), spread(), threads).value

    expect(markup).not.toContain('<span class="count" aria-hidden="true">1</span>')
  })

  it('gives each source its own root with nothing invented above them', () => {
    const two = summary({
      sources: [
        { ...summary().sources[0]!, id: 'src-1', label: 'reviewd' },
        { ...summary().sources[0]!, id: 'src-2', label: 'dotfiles' },
      ],
    })
    const markup = reviewPage(two, spread(), []).value

    expect(markup.match(/class="branch"/g)).toHaveLength(2)
    expect(markup).toContain('>reviewd</span>')
    expect(markup).toContain('>dotfiles</span>')
  })

  // A shape is no more a label than a colour, so the icon is hidden and the
  // distinction is repeated in text beside it.
  it('shows a git mark for a tracked source and a folder for a plain directory', () => {
    const tracked = reviewPage(summary(), spread(), []).value
    const loose = reviewPage(
      summary({ sources: [{ ...summary().sources[0]!, vcs: 'none', baseRef: null }] }),
      spread(),
      [],
    ).value

    expect(tracked).toContain('git repository')
    expect(loose).toContain('>directory<')
    expect(loose).not.toContain('git repository')

    // Phosphor draws on a 256 grid, so this also catches the icons silently
    // failing to load and rendering as nothing.
    expect(tracked).toMatch(/<svg class="vcs"[^>]*viewBox="0 0 256 256"/)
    expect(loose).toMatch(/<svg class="vcs"[^>]*viewBox="0 0 256 256"/)
  })

  it('keeps both icons out of the accessibility tree', () => {
    const markup = reviewPage(summary(), spread(), []).value

    expect(markup).toMatch(/<svg class="vcs"[^>]*aria-hidden="true"/)
  })

  it('says how much is in the review before any of it', () => {
    expect(reviewPage(summary(), spread(), []).value).toContain('3 files in')
  })
})

describe('hiding the file tree', () => {
  const withRail = (rail: 'open' | 'closed') =>
    reviewPage(summary(), [file('src/a.ts')], [], undefined, 'split', new Set(), rail).value

  it('shows the tree by default', () => {
    const markup = reviewPage(summary(), [file('src/a.ts')], []).value

    expect(markup).toContain('rail-open')
    expect(markup).toContain('Hide files')
    expect(markup).toContain('aria-expanded="true"')
  })

  it('offers the way back when it is closed', () => {
    const markup = withRail('closed')

    expect(markup).toContain('rail-closed')
    expect(markup).toContain('Show files')
    expect(markup).toContain('aria-expanded="false"')
  })

  // The control is a link that sets a cookie, like the side-by-side choice, so
  // it survives a reload and works with no script running.
  it('is a link, not a script', () => {
    expect(withRail('open')).toContain('?rail=closed')
    expect(withRail('closed')).toContain('?rail=open')
  })

  it('still renders the tree markup so the state is only visual', () => {
    // Closed hides the rail in CSS rather than dropping it, which keeps the
    // page one document and the toggle instant.
    expect(withRail('closed')).toContain('class="scope"')
  })
})

describe('reading the rail state', () => {
  it('defaults to open', () => {
    expect(parseRail(undefined)).toBe('open')
    expect(parseRail('')).toBe('open')
    expect(parseRail('anything')).toBe('open')
  })

  it('closes only when asked', () => {
    expect(parseRail('closed')).toBe('closed')
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
