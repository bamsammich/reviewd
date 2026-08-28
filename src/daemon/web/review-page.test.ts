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
    fileCount: 1,
    threadsAwaitingAgent: 0,
    threadsAwaitingHuman: 0,
    lastSubmissionAt: 0,
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
  // `\s` rather than a literal space after the tag name for the same reason:
  // these templates are formatted by prettier, which is free to put each
  // attribute on its own line, and it did. Three tests failed on the newline
  // while the page they were checking rendered correctly.
  const key = foldKey(SOURCE, path)
  const match = markup.match(new RegExp(`<details\\s[^>]*data-fold="${key}"[^>]*>`))
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
 * A page that has stopped being live has to say so.
 *
 * Reported from a real review rather than found here: a revision landed, a
 * reply landed, and the open page showed neither until it was reloaded by
 * hand. The daemon was doing its part — the stream emits `revision` and
 * `threads` the instant either happens, and heartbeats between them — so the
 * failure was entirely in the page, and it was a silent one. The stream had no
 * `error` listener, and every failure path in the poll below it was a bare
 * `return`. A daemon that had gone away and a daemon with nothing to say
 * produced the same page.
 *
 * These assert on the script the page ships, which is a coarse instrument. It
 * is the one available without a browser, and it holds the property that
 * actually broke: that a failure reaches something which can report it.
 */
describe('losing contact with the daemon', () => {
  const script = (): string => reviewPage(summary(), [file('src/a.ts')], []).value

  /** The poll, sliced out of the script so a match cannot come from elsewhere. */
  const poll = (markup: string): string =>
    markup.slice(
      markup.indexOf('async function checkForChanges'),
      markup.indexOf('function markCurrentFile'),
    )

  it('watches the event stream for failure', () => {
    expect(script()).toContain("source.addEventListener('error'")
  })

  it('reports a poll that could not reach the daemon, either way it can fail', () => {
    const body = poll(script())

    // A non-OK answer and a thrown fetch are different failures and both were
    // a bare return. Neither may be one again.
    expect(body).toMatch(/if \(!response\.ok\) \{ checkFailed\(\); return; \}/)
    expect(body).toMatch(/catch \{\s*checkFailed\(\);\s*return;\s*\}/)
  })

  it('does not consult the draft state at all, and leaves that to land()', () => {
    const body = poll(script())

    // This used to return early while a textarea held anything, so a page
    // could not notice it had gone stale for as long as a draft sat there.
    // land() already defers correctly and retries every two seconds, so the
    // poll now has no opinion about typing and every path goes through it.
    expect(body).not.toContain('busyWriting()')
    expect(body).toContain('land()')
  })

  it('ships somewhere to say so, and a rule to draw it', () => {
    const markup = script()

    expect(markup).toContain('keeping-up')
    expect(markup).toMatch(/header\.top \.keeping-up\s*\{/)
  })

  /**
   * The status goes in the bar, never over the diff.
   *
   * It started as a pill floating above the action bar and that was wrong for
   * a reason the first screenshot made obvious: in a browser that blocks
   * background requests this state never ends, and a permanent overlay is a
   * permanent hole in the code being read. Moving it left only changed which
   * lines it covered.
   */
  it('puts the status in the header rather than on top of the code', () => {
    const markup = script()

    expect(markup).toContain('bar.appendChild(note)')
    expect(markup).not.toMatch(/document\.body\.appendChild\(note\)/)
    // The transient "updating when you stop typing" pill is a different thing
    // and stays an overlay, because it lasts a moment.
    expect(markup).toContain('document.body.appendChild(pill)')
  })

  it('survives the refresh that replaces the header it lives in', () => {
    const markup = script()
    const fn = markup.slice(markup.indexOf('async function refresh'), markup.indexOf('let settled'))

    // refresh() swaps header.top wholesale for a freshly rendered one, which
    // does not carry the status. Without this it vanishes on the first refresh
    // and the page goes back to looking live while it is not.
    expect(fn).toMatch(/if \(offline\) showStale\(blockedBefore\(\)\)/)
  })

  it('lets the reviewer hide the notice', () => {
    const markup = script()

    expect(markup).toContain("close.className = 'dismiss'")
    expect(markup).toMatch(/close\.addEventListener\('click', \(\) => note\.remove\(\)\)/)
  })
})

/**
 * A browser that refuses to make background requests.
 *
 * Claude Code's built-in browser loads a review over a Tailscale name, runs
 * its inline script, and posts its forms, while blocking every fetch, XHR,
 * image and stylesheet the page asks for from that same origin. All four
 * measured, all four blocked, while curl against the identical URL answers
 * 200 and the response headers are byte-identical to the loopback ones.
 *
 * So the page is not broken there, it has one channel left. Top-level
 * navigation still works, which makes a reload the way those browsers keep up.
 */
describe('a browser that blocks background requests', () => {
  const script = (): string => reviewPage(summary(), [file('src/a.ts')], []).value

  it('offers a refresh the reviewer drives', () => {
    const markup = script()

    expect(markup).toContain("refresh.textContent = 'Refresh'")
    expect(markup).toContain('location.reload()')
  })

  /**
   * Nothing reloads on a timer.
   *
   * This first shipped reloading every thirty seconds whenever background
   * requests were blocked, on the reasoning that a reload was the one channel
   * left. Both halves were wrong. The page has no evidence anything changed,
   * so a timed reload is a guess on a schedule; and a page that moves under
   * someone reading code takes a decision that belongs to them and costs them
   * their place. It says it is behind and lets them pick the moment.
   */
  it('never moves the page on its own', () => {
    const markup = script()

    expect(markup).not.toContain('scheduleReload')
    expect(markup).not.toContain('reloadTimer')
    // The only reload is the one wired to the button.
    expect(markup.match(/location\.reload\(\)/g)?.length).toBe(2)
  })

  /**
   * The one link that fixes it, offered without having to detect anything.
   *
   * Claude Code's built-in browser permits background requests to a loopback
   * host and refuses them to every other name. The control was a server on
   * 127.0.0.1:7788 reached as localtest.me, a public name that resolves to
   * 127.0.0.1: allowed by address, blocked by name. So the address bar is the
   * fix and an /etc/hosts entry is not.
   *
   * The page cannot ask which browser it is in or whether the daemon is on
   * this machine. It does not need to: the offer appears only after background
   * requests have already failed, which is a situation that selects its own
   * audience.
   */
  it('offers the same review on loopback, where those requests are permitted', () => {
    const markup = script()

    expect(markup).toContain("local.textContent = 'Open on localhost'")
    expect(markup).toContain('function loopbackHere')
  })

  it('keeps the port and path, changing only the name', () => {
    const markup = script()
    const fn = markup.slice(
      markup.indexOf('function loopbackHere'),
      markup.indexOf('function showStale'),
    )

    expect(fn).toContain('location.pathname')
    expect(fn).toContain('location.port')
  })

  it('offers nothing when the page is already on a loopback name', () => {
    const markup = script()
    const fn = markup.slice(
      markup.indexOf('function loopbackHere'),
      markup.indexOf('function showStale'),
    )

    // Otherwise the notice offers to take the reviewer where they already are.
    // The privileged set is the one Claude Code's desktop documentation names:
    // localhost, any *.localhost subdomain, 127.0.0.1, and ::1. The subdomain
    // form is the one easily missed.
    expect(fn).toContain("host === '127.0.0.1'")
    expect(fn).toContain("host === '::1'")
    expect(fn).toContain("host === 'localhost'")
    expect(fn).toContain("host.endsWith('.localhost')")
    expect(fn).toContain('return null')
  })

  it('says what is true rather than what it intends to do', () => {
    const markup = script()

    // It cannot tell whether anything changed, so it must not imply it can.
    expect(markup).toContain("what.textContent = 'Not live'")
    expect(markup).not.toContain('Refreshing every')
  })

  it('remembers across a reload that this browser blocks requests', () => {
    const markup = script()

    // Without this the page comes back, starts the two-failure count over, and
    // reloads again on a whim rather than because it learned anything.
    expect(markup).toContain('reviewd_background_blocked')
    expect(markup).toContain('sessionStorage')
  })

  it('survives storage being denied rather than failing the page', () => {
    const markup = script()
    const fn = markup.slice(
      markup.indexOf('function blockedBefore'),
      markup.indexOf('function rememberBlocked'),
    )

    expect(fn).toContain('catch')
  })
})

describe('the live stream is reachable for diagnosis', () => {
  it('hangs the stream off the page rather than sealing it in a block', () => {
    const markup = reviewPage(summary(), [file('src/a.ts')], []).value

    // Diagnosing a page that had stopped updating meant opening a second
    // EventSource from the console to guess at the state of the first.
    expect(markup).toContain('window.reviewdLive')
  })
})

/**
 * The one place in these templates where whitespace is content.
 *
 * Everything else the page emits is markup, where a newline between attributes
 * or tags means nothing, so prettier is free to reflow it and does. Inside the
 * code cell it is the reviewer's own indentation, and a formatter that broke
 * `<span class="t">${code}</span>` across lines would quietly add spaces to
 * every line of every diff. Nothing failed when prettier last reflowed this
 * file, which is the problem: only three tests noticed, by matching a regex
 * against an unrelated tag.
 */
describe('indentation in the code cell', () => {
  const indented = (): FileView => ({
    ...file('src/a.ts'),
    oldText: 'fn()\n',
    newText: 'fn()\n\tif (x) {\n        deeply()\n',
  })

  it('renders a line byte for byte, leading whitespace included', () => {
    const markup = reviewPage(summary(), [indented()], []).value

    expect(markup).toContain('<span class="t">\tif (x) {</span>')
    expect(markup).toContain('<span class="t">        deeply()</span>')
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

  const at = (side: 'old' | 'new', line: number) => thread({ side, line })

  const count = (markup: string, id: string) => markup.split(`id="t-${id}"`).length - 1

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

  /**
   * A browser drags a link by default, and that drag swallows the pointer
   * sequence the gutter selection needs. Pressing the + and pulling down then
   * does nothing, in the one column the page tells the reader to use.
   */
  it('stops the gutter links being dragged as links', () => {
    const markup = reviewPage(summary(), [many()], []).value
    const anchors = markup.match(/<a[^>]*class="addnote[^"]*"[^>]*>/g) ?? []

    expect(anchors.length).toBeGreaterThan(0)
    for (const anchor of anchors) expect(anchor).toContain('draggable="false"')
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

// A CSS assertion is a weak test, so it encodes the invariant rather than the
// values: whatever the numbers become, a pinned rail has to have somewhere for
// a tall tree to go. Without this the entries past the fold were unreachable —
// the page scrolled and the rail stayed put.
describe('a rail taller than the window', () => {
  const railRule = (): string => {
    const markup = reviewPage(summary(), [file('src/a.ts')], []).value
    const rule = markup.match(/main\.review \.rail \{([^}]*)\}/)

    expect(rule, 'no rule for main.review .rail').not.toBeNull()
    return rule![1]!
  }

  it('bounds a sticky rail and gives it its own scroll', () => {
    const rule = railRule()

    expect(rule).toContain('sticky')
    expect(rule).toContain('max-height')
    expect(rule).toContain('overflow-y: auto')
  })

  it('measures the submit bar rather than guessing its height', () => {
    const markup = reviewPage(summary(), [file('src/a.ts')], []).value

    expect(markup).toMatch(/setProperty\(\s*'--bar-height'/)
    // The guess stays as a fallback for the frame before the script runs.
    expect(railRule()).toContain('var(--bar-height, 4.5rem)')
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

  // The bug this covers: the rail sorted itself (directories first, each group
  // by segment) while the diff sorted by whole path. Both were internally
  // consistent, and every unit test was right about its own half, so clicking
  // the fifth entry in the rail landed on some other file's block. Assert the
  // two sequences against each other rather than against a fixed order.
  it('lists files in the order the diff shows them', () => {
    const many = [
      'src/daemon/web/tree.ts',
      'src/daemon/http/serve.ts',
      'src/index.ts',
      'README.md',
      'docs/spec.md',
      'src/ctl/main.ts',
    ].map((path) => file(path))
    const markup = reviewPage(summary(), many, []).value

    const rail = [...markup.matchAll(/data-tree-file="([^"]+)"/g)].map((m) => m[1])
    // Attributes are matched wherever they sit in the tag rather than in one
    // exact order on one line. Prettier is free to put each on its own line
    // and does, which broke this while the page it checks rendered correctly.
    const diff = [...markup.matchAll(/<details\s[^>]*id="file-([^"]+)"/g)].map((m) => m[1])

    expect(rail).toHaveLength(many.length)
    expect(rail).toEqual(diff)
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
