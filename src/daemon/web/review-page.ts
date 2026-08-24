import type { ReviewSummary, SourceSummary, Thread } from '../../protocol.js'
import { Palette, renderLine, type Token } from './highlight.js'
import { FOLDER_ICON, GIT_ICON } from './icons.js'
import { escapeHtml, html, raw, type SafeHtml } from './html.js'
// anchorForHalf is gone from here: nothing in the renderer asks where a row is
// without also needing the file it is in, which is what a position carries.
import { buildRows, toHunks, toSplitRows, type Half, type SplitRow } from './hunks.js'
import { page, topBar } from './layout.js'
import type { FileView } from './pages.js'
import { basenameOf, displayPath } from './paths.js'
import { mintPageToken } from './tokens.js'
import { buildTree, type TreeDirectory, type TreeFile, type TreeNode } from './tree.js'
import {
  covers,
  inSameFile,
  positionAt,
  positionKey,
  positionOfThread,
  samePlace,
  type Position,
} from './position.js'

/**
 * The review page.
 *
 * Two questions have to be answerable without scrolling or guessing: what am I
 * looking at, and how do I say something about it. The scope list answers the
 * first by naming every root up front, and a visible control on every line
 * answers the second.
 */

/**
 * The comment box a reviewer has open, which is a position like any other.
 *
 * Kept as an alias rather than its own shape so that a box, a thread and a row
 * are all the same kind of thing and can be compared with the same functions.
 */
export type OpenBox = Position

/**
 * What one render of a page needs everywhere and never changes within it.
 *
 * The test a field had to pass to be in here is that something deep in the
 * tree reads it and nothing in between does. `folded` is read only when a file
 * block decides whether to open, and `palette` written only when a line is
 * drawn, but both have to travel through four functions with no use for them.
 *
 * Anything that varies as the render descends stays an argument — the file,
 * the row, the half, whether a heading shows. Folding those in would hide the
 * only things that actually differ between calls, which is the opposite of the
 * point.
 */
interface Page {
  review: ReviewSummary
  threads: Thread[]
  open: OpenBox | undefined
  folded: ReadonlySet<string>
  palette: Palette
}

export { parsePosition as parseOpenBox, positionKey as boxKey } from './position.js'

export type ViewMode = 'split' | 'unified'

export function parseViewMode(value: string | undefined): ViewMode {
  return value === 'unified' ? 'unified' : 'split'
}

/**
 * Whether the file tree is showing.
 *
 * A cookie rather than a `<details>`, because closing it should hand the space
 * to the diff. A disclosure would hide the contents and leave the empty column
 * behind, and the layout that has to change is a grid the server writes.
 */
export type RailState = 'open' | 'closed'

export function parseRail(value: string | undefined): RailState {
  return value === 'closed' ? 'closed' : 'open'
}

/** Identifies one file block across renders. Opaque: only membership is asked. */
export function foldKey(sourceId: string, path: string): string {
  return `${sourceId}:${path}`
}

/**
 * Which files the reviewer collapsed, from the cookie the page writes.
 *
 * The value is the review id followed by one encoded key per collapsed file.
 * Stamping the review id means a cookie left over from another review reads as
 * empty rather than folding whatever happens to share a path, and one cookie
 * covers the whole tool instead of accumulating one per review ever opened.
 */
export function parseFolds(value: string | undefined, reviewId: string): Set<string> {
  const folds = new Set<string>()
  if (!value) return folds

  const [owner, ...keys] = value.split('|')
  if (owner !== reviewId) return folds

  for (const key of keys) {
    try {
      if (key) folds.add(decodeURIComponent(key))
    } catch {
      // A hand-edited cookie is not worth failing a page render over.
    }
  }

  return folds
}

export function reviewPage(
  review: ReviewSummary,
  files: FileView[],
  threads: Thread[],
  open?: OpenBox,
  view: ViewMode = 'split',
  folded: ReadonlySet<string> = new Set(),
  rail: RailState = 'open',
): SafeHtml {
  const drafts = threads.reduce(
    (count, thread) => count + thread.messages.filter((m) => m.submittedAt === null).length,
    0,
  )
  const awaitingYou = threads.filter((t) => t.state === 'active' && t.turn === 'human').length
  const outdated = threads.filter((t) => t.state === 'outdated')
  const grouped = groupBySource(review.sources, files)
  // Filled while the body renders, read after. Every colour the diff used, and
  // no others, reaches the stylesheet at the end.
  const palette = new Palette()
  const page_: Page = { review, threads, open, folded, palette }

  const body = html` ${topBar(review.title, html`<span class="rev">rev ${review.snapshotSeq}</span>`)}
    <main
      id="main"
      class="review with-bar view-${view} rail-${rail}"
      data-review="${review.reviewId}"
    >
      <!--
    The token the script copies into the comment box it builds, and the state
    the poll compares against. Both live inside main so that a refresh, which
    replaces main's contents, brings new ones rather than leaving the page
    holding a token and a revision number from before it caught up.
  -->
      <input
        type="hidden"
        id="page-token"
        value="${mintPageToken(review.reviewId, review.snapshotSeq, Date.now())}"
        data-revision="${review.snapshotSeq}"
        data-awaiting="${awaitingYou}"
      />
      <div class="rail">
        <h1 class="page-title">${review.title}</h1>
        ${scopeList(grouped, threads)} ${coaching(threads.length, drafts, awaitingYou)}
      </div>

      <div class="files">
        ${
          files.length === 0
            ? html`<p class="emptystate">This revision changed nothing.</p>`
            : raw('')
        }
        ${viewToggle(review, view, rail)}
        ${grouped.map((group) => sourceGroup(page_, group, grouped.length > 1))}
        ${outdatedBlock(page_, outdated)}
      </div>
    </main>
    ${submitBar(review, drafts, awaitingYou)}`

  const highlighting = palette.css()

  return page(
    `${review.title} · reviewd`,
    body,
    raw(`${highlighting ? `<style>${highlighting}</style>` : ''}<script>${SCRIPT}</script>`),
  )
}

interface SourceGroup {
  source: SourceSummary
  files: FileView[]
}

function groupBySource(sources: SourceSummary[], files: FileView[]): SourceGroup[] {
  return sources.map((source) => ({
    source,
    files: files.filter((file) => file.sourceId === source.id),
  }))
}

/**
 * What is under review, named before anything else.
 *
 * A path is shown home-relative and elided from the middle, because the
 * segment that identifies a repository sits at the end and the prefix is the
 * same for everything a person owns. The full path stays in the title
 * attribute for anyone who needs it.
 */
/**
 * The rail: every source, and under each one a tree of what changed.
 *
 * Several roots sit side by side with no parent above them, because a review
 * spanning two repositories has no common directory and inventing one would
 * claim a relationship that does not exist.
 *
 * Directories are `<details>`, so the tree collapses without a script, arrives
 * keyboard-operable, and announces its own expanded state. Nothing here needs
 * JavaScript except the marker for the file you are currently reading, which
 * is the one thing the server cannot know.
 */
function scopeList(groups: SourceGroup[], threads: Thread[]): SafeHtml {
  if (groups.length === 0) return raw('')

  const files = groups.reduce((total, group) => total + group.files.length, 0)

  return html`<nav class="scope" aria-labelledby="scope-heading">
    <h2 id="scope-heading">
      ${files} file${files === 1 ? '' : 's'} in
      ${groups.length === 1 ? '1 place' : `${groups.length} places`}
    </h2>
    ${groups.map((group) => sourceBranch(group, threads))}
  </nav>`
}

function sourceBranch(group: SourceGroup, threads: Thread[]): SafeHtml {
  const name = group.source.label || basenameOf(group.source.rootPath)
  const tracked = group.source.vcs === 'git'

  return html`<div class="branch">
    <a class="root ${group.source.approved ? 'ok' : ''}" href="#src-${group.source.id}">
      ${tracked ? GIT_ICON : FOLDER_ICON}
      <span class="visually-hidden">${tracked ? 'git repository' : 'directory'}</span>
      <span class="name">${name}</span>
      ${group.source.approved ? html`<span class="badge approved">approved</span>` : raw('')}
      <span class="path" title="${group.source.rootPath}"
        >${displayPath(group.source.rootPath)}</span
      >
    </a>
    ${treeList(buildTree(group.files), threads)}
  </div>`
}

function treeList(nodes: TreeNode[], threads: Thread[]): SafeHtml {
  if (nodes.length === 0) return raw('')

  return html`<ul class="tree">
    ${nodes.map(
      (node) =>
        html`<li>
          ${node.kind === 'directory' ? treeDirectory(node, threads) : treeFile(node, threads)}
        </li>`,
    )}
  </ul>`
}

function treeDirectory(node: TreeDirectory, threads: Thread[]): SafeHtml {
  return html`<details class="dir" open>
    <summary>
      <span class="name">${node.name}</span>
      <span class="count" aria-hidden="true">${node.fileCount}</span>
      <span class="visually-hidden">
        ${node.fileCount} file${node.fileCount === 1 ? '' : 's'}
      </span>
    </summary>
    ${treeList(node.children, threads)}
  </details>`
}

/** First letter of the change, because colour alone is not a label. */
const CHANGE_MARK: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  binary: 'B',
}

function treeFile(node: TreeFile, threads: Thread[]): SafeHtml {
  const { file } = node
  const key = foldKey(file.sourceId, file.path)
  const comments = threads.filter(
    (thread) => thread.state !== 'outdated' && foldKey(thread.sourceId, thread.path) === key,
  ).length

  const mark = CHANGE_MARK[file.changeType] ?? '?'

  return html`<a class="leaf" href="#file-${key}" data-tree-file="${key}">
    <span class="mark ${file.changeType}" aria-hidden="true">${mark}</span>
    <span class="name">${node.name}</span>
    ${comments > 0 ? html`<span class="count" aria-hidden="true">${comments}</span>` : raw('')}
    <span class="visually-hidden">
      ${file.changeType}${comments > 0 ? `, ${comments} comment${comments === 1 ? '' : 's'}` : ''}
    </span>
  </a>`
}

/**
 * The one line that says how to review.
 *
 * Shown until the reviewer has written something, because the affordance it
 * describes is discoverable but the rule about drafts is not: nothing reaches
 * the agent until a verdict button, and a person who does not know that will
 * wonder why their comment went nowhere.
 */
function coaching(threadCount: number, drafts: number, awaitingYou: number): SafeHtml {
  if (awaitingYou > 0) {
    return html`<p class="hint">
      <b>${awaitingYou} thread${awaitingYou === 1 ? '' : 's'} waiting on you.</b>
      Reply in place, then send with a verdict below.
    </p>`
  }

  if (drafts > 0) {
    return html`<p class="hint">
      <b>${drafts} comment${drafts === 1 ? '' : 's'} not sent yet.</b>
      Choose a verdict below to send them to the agent.
    </p>`
  }

  if (threadCount === 0) {
    return html`<p class="hint">
      Tap <span class="key">+</span> beside any line to comment.
      <b>Nothing reaches the agent</b> until you choose a verdict below.
    </p>`
  }

  return raw('')
}

function sourceGroup(page: Page, group: SourceGroup, showHeading: boolean): SafeHtml {
  return html`<section class="sourcegroup" id="src-${group.source.id}">
    ${
      showHeading
        ? html`<h2>
            <span>${group.source.label || basenameOf(group.source.rootPath)}</span>
            <span class="path" title="${group.source.rootPath}"
              >${displayPath(group.source.rootPath, undefined, 52)}</span
            >
          </h2>`
        : raw('')
    }
    ${
      group.files.length === 0
        ? html`<p class="note">Nothing changed in this one.</p>`
        : group.files.map((file) => fileBlock(page, file))
    }
  </section>`
}

function fileBlock(page: Page, file: FileView): SafeHtml {
  const rows = file.isBinary || file.truncated ? [] : buildRows(file.oldText, file.newText)
  const hunks = toHunks(rows)

  const key = foldKey(file.sourceId, file.path)
  const mine = page.threads.filter((thread) => foldKey(thread.sourceId, thread.path) === key)

  // A collapsed file stays collapsed across renders, except when the comment
  // box the reviewer just opened lives inside it. Honouring the fold there
  // would hide the box they are trying to type into.
  const holdsBox = page.open !== undefined && foldKey(page.open.sourceId, page.open.path) === key
  const expanded = holdsBox || !page.folded.has(key)

  return html`<details
    class="file"
    id="file-${key}"
    data-fold="${key}"
    ${expanded ? raw('open') : raw('')}
  >
    <summary>
      <h3>${file.path}</h3>
      <span class="badge">${file.changeType}</span>
      ${
        mine.length > 0
          ? html`<span class="badge you"
              >${mine.length} comment${mine.length === 1 ? '' : 's'}</span
            >`
          : raw('')
      }
    </summary>
    ${
      file.isBinary
        ? html`<p class="note">Binary file, not shown.</p>`
        : file.truncated
          ? html`<p class="note">File too large to display.</p>`
          : hunks.length === 0
            ? html`<p class="note">No textual change.</p>`
            : html`<div class="diff">
                ${hunks.map(
                  (hunk) => html`
                    <div class="hunkhead">${hunk.header}</div>
                    ${toSplitRows(hunk.rows).map((row) => splitRow(page, file, row, mine))}
                  `,
                )}
              </div>`
    }
  </details>`
}

/**
 * One row of the diff, carrying both halves.
 *
 * Split and unified render the same markup: side by side when there is room,
 * stacked when there is not. `data-unified` says which halves survive the
 * stack, so a context line is not printed twice.
 */
/** `mine` is this file's threads, already filtered by the caller that has them. */
function splitRow(page: Page, file: FileView, row: SplitRow, mine: Thread[]): SafeHtml {
  // Both halves, with nothing to deduplicate. A half now reports the side its
  // line number belongs to, so a thread matches exactly one of them. The
  // previous guard dropped the right half on context rows to stop a thread
  // rendering twice, which worked by hiding the real fault and would have
  // silently dropped any comment anchored to the new side of a context line.
  const attached = [...threadsAt(file, mine, row.left), ...threadsAt(file, mine, row.right)]
  const boxHere = [row.left, row.right].find((half) => isOpenOn(page.open, file, half))

  return html`<div class="row" data-unified="${row.unified}">
      ${half(page, file, row.left, 'left')} ${half(page, file, row.right, 'right')}
    </div>
    ${attached.map((thread) => threadBlock(page, thread, false))}
    ${boxHere && page.open ? newThreadBlock(page, file, page.open) : raw('')}`
}

/** The threads that hang from this row: same place, and still live. */
function threadsAt(file: FileView, threads: Thread[], side: Half): Thread[] {
  const here = positionAt(file, side)
  if (!here) return []

  return threads.filter(
    (thread) => thread.state !== 'outdated' && samePlace(positionOfThread(thread), here),
  )
}

function isOpenOn(open: OpenBox | undefined, file: FileView, side: Half): boolean {
  const here = positionAt(file, side)
  return open !== undefined && here !== undefined && samePlace(open, here)
}

function half(page: Page, file: FileView, side: Half, which: 'left' | 'right'): SafeHtml {
  const here = positionAt(file, side)

  if (side.kind === 'empty' || !here) {
    return html`<div class="side ${which} empty" aria-hidden="true"></div>`
  }

  const { review, open } = page
  const sign = side.kind === 'added' ? '+' : side.kind === 'removed' ? '-' : ' '
  const keyAt = (line: number) => positionKey({ ...here, line, endLine: null })

  // A line below an open box on the same file and side can extend it down to
  // itself. This is a link rather than a gesture, so it also serves as the
  // fallback when the drag handler has not loaded.
  const extendable = open !== undefined && inSameFile(open, here) && open.line < here.line

  const action = extendable
    ? html`<a
        class="addnote extend"
        href="${raw(
          `/r/${review.reviewId}?box=${encodeURIComponent(keyAt(open.line))}&to=${here.line}#box`,
        )}"
        aria-label="Extend the comment down to line ${here.line}"
        title="Extend down to line ${here.line}"
        >↧</a
      >`
    : html`<a
        class="addnote"
        href="${raw(`/r/${review.reviewId}?box=${encodeURIComponent(keyAt(here.line))}#box`)}"
        data-box
        aria-label="Comment on ${file.path} line ${here.line}"
        title="Comment on line ${here.line}"
        >+</a
      >`

  // Highlighted where we recognise the language and the line counts agreed,
  // and the raw text otherwise. `side.text` is escaped by the template;
  // renderLine escapes each token itself.
  const tokens = tokensForHalf(file, side, which)
  const code = tokens ? renderLine(tokens, page.palette) : side.text

  // The box key and line ride on the element so the drag handler can build a
  // selection without parsing hrefs back apart.
  const drag = raw(
    ` data-key="${escapeHtml(keyAt(here.line))}" data-line="${here.line}"` +
      ` data-file="${escapeHtml(foldKey(file.sourceId, file.path))}"` +
      ` data-review="${escapeHtml(review.reviewId)}"`,
  )

  // The code itself is plain text. Making it a link put the source of every
  // line into the accessibility tree as a control name, which told a screen
  // reader user nothing about what activating it would do.
  const covered = coveredBy(page, here) ? ' covered' : ''

  return html`<div class="side ${which} ${side.kind}${covered}" ${drag}>
    <span class="n">${side.line ?? ''}</span>
    <span class="act">${action}</span>
    <span class="sign" aria-hidden="true">${sign}</span>
    <span class="t">${code}</span>
  </div>`
}

/**
 * Whether a line falls inside a comment's range.
 *
 * Both a thread that already covers a block and a selection being extended
 * right now, so the shading a reviewer sees while choosing an end is the same
 * shading the saved comment gets.
 */
function coveredBy(page: Page, here: Position): boolean {
  // A one-line comment covers only its own line, and shading a single line
  // says nothing the row is not already saying. So only ranges shade.
  const isRange = (position: Position) => position.endLine !== null

  if (page.open && isRange(page.open) && covers(page.open, here)) return true

  return page.threads.some((thread) => {
    const position = positionOfThread(thread)
    return thread.state !== 'outdated' && isRange(position) && covers(position, here)
  })
}

/**
 * The tokens for one line, or nothing if this file renders plain.
 *
 * Which side a half reads from follows the diff, not the column: a removed
 * line sits on the left and belongs to the old text, an added line sits on the
 * right and belongs to the new, and context appears in both.
 */
function tokensForHalf(file: FileView, side: Half, which: 'left' | 'right'): Token[] | undefined {
  if (side.line === null) return undefined

  const lines = which === 'left' ? file.oldTokens : file.newTokens
  return lines?.[side.line - 1]
}

function threadBlock(page: Page, thread: Thread, showLocation: boolean): SafeHtml {
  return html`<div class="threadrow">
    <div class="thread ${thread.state}" id="t-${thread.id}">
      ${
        showLocation
          ? html`<p class="where">${thread.sourceLabel} · ${thread.path}:${thread.line}</p>`
          : raw('')
      }
      ${
        thread.drifted
          ? html`<p class="drift">The code around this comment changed since it was written.</p>`
          : raw('')
      }
      ${thread.messages.map(
        (message) =>
          html`<div class="msg">
            <span class="who">${message.author === 'human' ? 'you' : 'agent'}</span>
            ${message.submittedAt === null ? html`<span class="badge draft">not sent</span>` : raw('')}
            <div class="body">${message.body}</div>
          </div>`,
      )}
      <details class="reply">
        <summary>Reply</summary>
        <form method="post" action="/r/${page.review.reviewId}/threads/${thread.id}/replies">
          ${tokenField(page)}
          <label class="visually-hidden" for="reply-${thread.id}"> Reply to this comment </label>
          <textarea id="reply-${thread.id}" name="body" rows="2" required></textarea>
          <div class="actions">
            <button type="submit" class="primary">Save reply</button>
          </div>
        </form>
      </details>
      <div class="actions">
        <form
          method="post"
          action="/r/${page.review.reviewId}/threads/${thread.id}/${
            thread.state === 'active' ? 'resolve' : 'reopen'
          }"
        >
          ${tokenField(page)}
          <button type="submit" class="quiet">
            ${thread.state === 'active' ? 'Resolve' : 'Reopen'}
          </button>
        </form>
      </div>
    </div>
  </div>`
}

/**
 * The hidden field that says this form came from a page the daemon drew.
 *
 * Every mutating form carries one. The daemon refuses a request without it,
 * which is what lets the cross-site check stop having to trust `Origin`.
 */
function tokenField(page: Page): SafeHtml {
  const token = mintPageToken(page.review.reviewId, page.review.snapshotSeq, Date.now())
  return html`<input type="hidden" name="token" value="${token}" />`
}

/** The form itself, which is a position plus somewhere to type. */
function newThreadBlock(page: Page, file: FileView, at: Position): SafeHtml {
  const id = `new-${at.sourceId}-${at.side}-${at.line}`
  const where = at.endLine ? `lines ${at.line} to ${at.endLine}` : `line ${at.line}`

  return html`<div class="threadrow">
    <div class="thread" id="box">
      <form method="post" action="/r/${page.review.reviewId}/threads">
        ${tokenField(page)}
        <input type="hidden" name="sourceId" value="${at.sourceId}" />
        <input type="hidden" name="path" value="${at.path}" />
        <input type="hidden" name="side" value="${at.side}" />
        <input type="hidden" name="line" value="${at.line}" />
        ${at.endLine ? html`<input type="hidden" name="endLine" value="${at.endLine}" />` : raw('')}
        <label for="${id}">Comment on ${file.path} ${where}</label>
        <textarea id="${id}" name="body" rows="3" autofocus required></textarea>
        <div class="actions">
          <button type="submit" class="primary">Save comment</button>
          <a class="btn quiet" href="/r/${page.review.reviewId}">Cancel</a>
        </div>
      </form>
    </div>
  </div>`
}

function outdatedBlock(page: Page, outdated: Thread[]): SafeHtml {
  if (outdated.length === 0) return raw('')

  return html`<details class="file">
    <summary>
      <h3>${outdated.length} outdated comment${outdated.length === 1 ? '' : 's'}</h3>
      <span class="badge">code is gone</span>
    </summary>
    <div class="diff">${outdated.map((thread) => threadBlock(page, thread, true))}</div>
  </details>`
}

/**
 * Split against unified.
 *
 * Hidden below the breakpoint where split stops fitting, because an option
 * that cannot be honored is worse than no option. The stylesheet stacks the
 * halves there whatever the stored preference says.
 */
function viewToggle(review: ReviewSummary, view: ViewMode, rail: RailState): SafeHtml {
  const other: ViewMode = view === 'split' ? 'unified' : 'split'
  const flip: RailState = rail === 'open' ? 'closed' : 'open'

  return html`<div class="viewtoggle">
    <a
      class="btn quiet"
      href="/r/${review.reviewId}?rail=${flip}"
      aria-expanded="${rail === 'open' ? 'true' : 'false'}"
      >${rail === 'open' ? 'Hide files' : 'Show files'}</a
    >
    <a class="btn quiet viewmode" href="/r/${review.reviewId}?view=${other}">
      ${other === 'split' ? 'Side by side' : 'Unified'}
    </a>
  </div>`
}

/**
 * The submit controls.
 *
 * One primary action at a time. With unsent comments the primary action is
 * requesting changes, because that is what a reviewer who has written something
 * usually means; with nothing unsent it is approving, because that is what a
 * reviewer who has read and is satisfied usually means. The state line says
 * what approving does, since unblocking a commit is not visible from here.
 *
 * Approval is its own state rather than an extra button on the same row. A
 * reviewer who has just approved and gets back a highlighted Approve reads it
 * as a click that did not land, and the two other ways out of approval sitting
 * beside it invite the wrong one. What is left is the one thing still true:
 * the decision is made and the agent has not committed yet.
 */
function submitBar(review: ReviewSummary, drafts: number, awaitingYou: number): SafeHtml {
  const approved = review.sources.length > 0 && review.sources.every((source) => source.approved)

  const state = approved
    ? drafts > 0
      ? html`<strong>Approved, ${drafts} comment${drafts === 1 ? '' : 's'} not sent.</strong>
          Sending them takes the approval back.`
      : html`<strong>Approved.</strong> Waiting for the agent to commit.`
    : drafts > 0
      ? html`<strong>${drafts} comment${drafts === 1 ? '' : 's'} not sent.</strong> Choose how to
          send them.`
      : awaitingYou > 0
        ? html`<strong>${awaitingYou} waiting on you.</strong> Reply above, or decide now.`
        : html`Approving lets the agent commit.`

  // A verdict carries the same token every other form does, and the route
  // additionally refuses one minted against an older revision.
  const token = mintPageToken(review.reviewId, review.snapshotSeq, Date.now())

  return html`<form class="bar" method="post" action="/r/${review.reviewId}/submit">
    <input type="hidden" name="token" value="${token}" />
    <div class="row">
      <p class="state" aria-live="polite">${state}</p>
      <div class="verdicts">
        ${
          approved
            ? html`${
                drafts > 0
                  ? html`<button type="submit" name="verdict" value="comment" class="quiet">
                        Send as notes
                      </button>`
                  : raw('')
              }
                <button
                  type="submit"
                  formaction="/r/${review.reviewId}/unapprove"
                  class="${drafts > 0 ? 'quiet' : 'primary'}"
                >
                  Unapprove
                </button>`
            : drafts > 0
              ? html`<button type="submit" name="verdict" value="comment" class="quiet">
                    Send as notes
                  </button>
                  <button type="submit" name="verdict" value="changes_requested" class="primary">
                    Request changes
                  </button>
                  <button type="submit" name="verdict" value="approved">Approve</button>`
              : html`<button type="submit" name="verdict" value="changes_requested" class="quiet">
                    Request changes
                  </button>
                  <button type="submit" name="verdict" value="approved" class="primary">
                    Approve
                  </button>`
        }
      </div>
    </div>
  </form>`
}

/**
 * Opens a comment box without a round trip, and remembers which files are
 * folded.
 *
 * Everything here is an enhancement: each link already works on its own, so a
 * failure to load leaves the page usable rather than inert. Without this the
 * folds simply do not persist, which is where the page started.
 *
 * The cookie carries the whole collapsed set on every toggle rather than a
 * diff, because the set is what the next render needs and rebuilding it from
 * the DOM cannot drift from what the reviewer is looking at.
 */
const SCRIPT = `
const FOLD_LIMIT = 3500;

/* ---- live updates ---------------------------------------------------- */

/* Never destroy something being written. A refresh replaces the whole main
   element, which would take an open comment box and whatever is typed into it
   with it, so the update waits for the reviewer to finish instead. */
function busyWriting() {
  const active = document.activeElement;
  if (active && active.tagName === 'TEXTAREA') return true;
  if (document.querySelector('.inline-box')) return true;

  for (const area of document.querySelectorAll('.thread textarea')) {
    if (area.value.trim()) return true;
  }

  return false;
}

function openReplies() {
  const state = {};
  for (const details of document.querySelectorAll('details.reply[open]')) {
    const thread = details.closest('.thread');
    const area = details.querySelector('textarea');
    if (thread) state[thread.id] = area ? area.value : '';
  }
  return state;
}

function restoreReplies(state) {
  for (const [id, value] of Object.entries(state)) {
    const details = document.querySelector('#' + CSS.escape(id) + ' details.reply');
    if (!details) continue;
    details.open = true;
    const area = details.querySelector('textarea');
    if (area) area.value = value;
  }
}

async function refresh() {
  const response = await fetch(location.href);
  if (!response.ok) return;

  const next = new DOMParser().parseFromString(await response.text(), 'text/html');
  const main = document.getElementById('main');
  const bar = document.querySelector('form.bar');
  const head = document.querySelector('header.top');
  const nextMain = next.getElementById('main');
  const nextBar = next.querySelector('form.bar');
  const nextHead = next.querySelector('header.top');
  if (!main || !nextMain) return;

  const replies = openReplies();
  const offset = window.scrollY;

  main.innerHTML = nextMain.innerHTML;
  if (bar && nextBar) bar.outerHTML = nextBar.outerHTML;
  // The revision label lives in the header, outside main, so replacing only
  // main left it showing a revision the page was no longer displaying.
  if (head && nextHead) head.outerHTML = nextHead.outerHTML;

  restoreReplies(replies);
  window.scrollTo(0, offset);
  measureBar();

  // A reviewer has to be able to see that the ground moved. Clearing the pill
  // as soon as the content lands makes it a flash behind the action bar, which
  // is the same as not saying anything.
  if (settled) {
    notice(true, settled);
    settled = null;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => notice(false), 6000);
  } else {
    notice(false);
  }
}

/*
 * What to say once the new content is actually on screen.
 *
 * Set before a refresh that the reviewer needs to notice, read after it lands.
 */
let settled = null;
let settleTimer = 0;

/*
 * The bar's real height, which nothing was measuring.
 *
 * The notice is positioned above it from a custom property that was never set,
 * so it fell back to a guess that is wrong whenever the bar wraps to two rows,
 * which on a phone is most of the time.
 */
function measureBar() {
  const bar = document.querySelector('form.bar');
  const height = bar ? bar.getBoundingClientRect().height : 72;
  document.documentElement.style.setProperty('--bar-height', Math.round(height) + 'px');
}

measureBar();
window.addEventListener('resize', measureBar);

let waiting = false;

function land() {
  if (busyWriting()) {
    notice(true);
    if (!waiting) {
      waiting = true;
      const tick = setInterval(() => {
        if (busyWriting()) return;
        clearInterval(tick);
        waiting = false;
        refresh();
      }, 2000);
    }
    return;
  }

  refresh();
}

function notice(show, message) {
  let pill = document.getElementById('live-notice');
  if (!show) { if (pill) pill.remove(); return; }
  if (pill) return;

  pill = document.createElement('div');
  pill.id = 'live-notice';
  pill.className = 'live-notice';
  pill.setAttribute('role', 'status');
  pill.textContent = message || 'New reply. Updating when you stop typing.';
  document.body.appendChild(pill);
}

/*
 * Losing contact has to be visible.
 *
 * Everything below this point is a way of finding out that the page is no
 * longer current. None of it used to be able to say so. The stream carried no
 * error handler at all, and every failure in the poll was a bare return, so a
 * daemon that had gone away and a daemon with nothing to report produced the
 * same page: one that looked live and was not. That is the exact state the
 * whole mechanism exists to prevent, arriving quietly instead of loudly.
 *
 * The poll decides, because it is the one that gets a straight answer. A
 * dropped stream is not evidence — EventSource reconnects on its own and a
 * blip means nothing — but two failed fetches in a row is a daemon that is not
 * there. Nothing here tries to recover the data; it tells the reviewer to
 * reload, which is the one move that always works.
 */
let missedChecks = 0;
let offline = false;

function contactLost() {
  if (offline) return;
  offline = true;

  const pill = document.createElement('div');
  pill.id = 'stale-notice';
  pill.className = 'live-notice stale';
  /* alert, not status: this is the page telling the reviewer it can no longer
     vouch for what they are reading, which is worth interrupting for. */
  pill.setAttribute('role', 'alert');
  pill.textContent = 'Not updating. Lost contact with reviewd — reload to see the current revision.';
  document.body.appendChild(pill);
}

function contactMade() {
  missedChecks = 0;
  if (!offline) return;
  offline = false;

  const pill = document.getElementById('stale-notice');
  if (pill) pill.remove();
}

/* Two in a row, so one dropped packet does not cry wolf. */
function checkFailed() {
  missedChecks += 1;
  if (missedChecks >= 2) contactLost();
}

const liveMain = document.getElementById('main');
if (liveMain && liveMain.dataset.review && 'EventSource' in window) {
  const source = new EventSource('/r/' + liveMain.dataset.review + '/events');
  source.addEventListener('threads', land);
  source.addEventListener('gone', () => { source.close(); location.reload(); });

  /* The stream retrying is its own business, so this does not report anything.
     What it means is that the fast path is down and the poll is now the only
     thing watching, so ask the poll straight away rather than waiting out its
     interval. Throttled, because a stream that cannot connect at all fires
     this over and over. */
  let lastErrorCheck = 0;
  source.addEventListener('error', () => {
    const at = Date.now();
    if (at - lastErrorCheck < 5000) return;
    lastErrorCheck = at;
    checkForChanges();
  });

  // A new revision is the case a stale page handles worst: the code on screen
  // has been replaced and the approve button is about to describe a revision
  // the reviewer never read. Refreshing turns that into the page catching up,
  // which is the only version of "the page still works" worth having.
  source.addEventListener('revision', (event) => {
    settled = 'Now showing revision ' + (event.data || '') + '.';
    notice(true, 'The agent pushed revision ' + (event.data || '') + '. Updating this page.');
    land();
  });

  // A phone that slept, or a network that dropped, misses events entirely.
  // EventSource reconnects on its own; the first connect is the page load, and
  // every one after it is a gap worth closing with a refresh.
  let connected = false;
  source.addEventListener('open', () => {
    if (connected) land();
    connected = true;
  });
}

/*
 * Asking, as well as being told.
 *
 * The event stream is the fast path and it is not a reliable one: an in-app
 * webview may never open it, a phone that sleeps drops it, and a proxy can hold
 * it. When that happens silently the page sits on code that has been replaced,
 * which is the failure this whole mechanism exists to prevent, so it cannot
 * rest on a connection staying up.
 *
 * Polling is the floor. One small request every fifteen seconds, and an
 * immediate one whenever the reviewer comes back to the tab, which is the case
 * a phone actually hits. The activity stamp is deliberately not compared: the
 * refresh is itself a GET on this page and stamps it, so keying on it would
 * make the page refresh forever.
 */
function renderedState() {
  const carrier = document.getElementById('page-token');
  if (!carrier) return null;
  return {
    seq: Number(carrier.dataset.revision),
    awaiting: Number(carrier.dataset.awaiting),
  };
}

/*
 * How old the token on this page is.
 *
 * Renewing a token on its own would be the wrong fix for a page whose content
 * has moved on: it would let an approval succeed while the reviewer is still
 * reading the revision it replaced, which is the thing the pin exists to catch.
 *
 * A page nobody has changed under is the opposite case. The content is still
 * accurate and only the token has aged, so refusing there is friction with
 * nothing behind it. Refreshing well before the daemon's limit renews the token
 * the only honest way, by fetching the page it belongs to.
 */
const TOKEN_RENEW_MS = 6 * 60 * 60 * 1000;

function tokenAgeMs() {
  const carrier = document.getElementById('page-token');
  if (!carrier) return 0;

  const issued = Number(String(carrier.value).split('.')[0]);
  return Number.isFinite(issued) ? Date.now() - issued : 0;
}

async function checkForChanges() {
  const was = renderedState();
  if (!was || !liveMain || !liveMain.dataset.review) return;

  let now;
  try {
    const response = await fetch('/api/reviews/' + liveMain.dataset.review);
    if (!response.ok) { checkFailed(); return; }
    const review = await response.json();
    now = { seq: review.snapshotSeq, awaiting: review.threadsAwaitingHuman };
  } catch {
    checkFailed();
    return;
  }

  contactMade();

  /* Below the fetch on purpose. Nothing may pull the ground out from under
     someone mid-sentence, but whether the daemon is still there is worth
     knowing while they type — and the old early return meant a page could not
     notice it had gone stale for as long as a textarea held anything. */
  if (busyWriting()) return;

  if (now.seq !== was.seq) {
    settled = 'Now showing revision ' + now.seq + '.';
    notice(true, 'The agent pushed revision ' + now.seq + '. Updating this page.');
    land();
    return;
  }

  if (now.awaiting !== was.awaiting) {
    land();
    return;
  }

  if (tokenAgeMs() > TOKEN_RENEW_MS) land();
}

if (liveMain && liveMain.dataset.review) {
  setInterval(() => {
    if (!document.hidden) checkForChanges();
  }, 15000);

  // Coming back to the tab is the moment a stale page is most likely and most
  // visible, so that check does not wait for the next tick.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkForChanges();
  });
}

/* ---- marking the file being read -------------------------------------- */

/* Which file the viewport is in is the one thing the tree cannot be rendered
   knowing. Without this the tree still lists and still navigates; it just does
   not point at where you are. */
function markCurrentFile() {
  const bar = document.querySelector('header.top');
  const line = bar ? bar.getBoundingClientRect().bottom + 1 : 1;
  let current = null;

  for (const file of document.querySelectorAll('details.file[data-fold]')) {
    const box = file.getBoundingClientRect();
    // The file spanning the sticky line, which is the one whose header is
    // pinned and therefore the one being read.
    if (box.top <= line && box.bottom > line) { current = file.dataset.fold; break; }
  }

  for (const leaf of document.querySelectorAll('.scope a.leaf')) {
    if (leaf.dataset.treeFile === current) leaf.setAttribute('aria-current', 'true');
    else leaf.removeAttribute('aria-current');
  }
}

/* Cancel and reschedule rather than latch a boolean. requestAnimationFrame
   does not run in a hidden tab, so a "queued" flag set before the tab was
   backgrounded is never cleared and the marker stays dead after the reader
   comes back. Cancelling means the worst case is one frame not drawn. */
let markHandle = 0;
addEventListener('scroll', () => {
  cancelAnimationFrame(markHandle);
  markHandle = requestAnimationFrame(markCurrentFile);
}, { passive: true });

/* A tab that was hidden while it loaded never ran the frame, so catch up when
   the reader looks at it. */
addEventListener('visibilitychange', () => {
  if (!document.hidden) markCurrentFile();
});

markCurrentFile();

/* ---- dragging a range ------------------------------------------------ */

/* Drag down the gutter to pick a block, the way a diff on the web usually
   works. Only the gutter starts a drag — the line numbers, the + control and
   the sign column — so dragging across the code still selects text.

   Everything here is an enhancement over the link on each line, which already
   extends a selection in two taps. That path is what a phone uses, since a
   drag on a touch screen is a scroll. */
let anchorSide = null;
let dragging = false;

function gutter(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || !target.closest('.n, .act, .sign')) return null;
  return target.closest('.side[data-key]');
}

function paint(from, to) {
  const a = Math.min(Number(from.dataset.line), Number(to.dataset.line));
  const b = Math.max(Number(from.dataset.line), Number(to.dataset.line));

  for (const side of document.querySelectorAll('.side[data-line]')) {
    // Same file and same column, or line 40 of every other file lights up too.
    const hit = side.dataset.file === from.dataset.file &&
      sameColumn(side, from) &&
      Number(side.dataset.line) >= a &&
      Number(side.dataset.line) <= b;

    side.classList.toggle('selecting', hit);
  }
}

function sameColumn(one, other) {
  return one.classList.contains('left') === other.classList.contains('left');
}

function clearPaint() {
  for (const side of document.querySelectorAll('.side.selecting')) {
    side.classList.remove('selecting');
  }
}

document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;

  const side = gutter(event);
  if (!side) return;

  anchorSide = side;
  dragging = false;
});

document.addEventListener('pointermove', (event) => {
  if (!anchorSide) return;

  const side = gutter(event);
  if (!side || !sameColumn(side, anchorSide)) return;
  if (side === anchorSide && !dragging) return;

  // Only once the pointer has actually left the line it started on, so a plain
  // click on the + control is still a click.
  dragging = true;
  event.preventDefault();
  paint(anchorSide, side);
});

document.addEventListener('pointerup', (event) => {
  const from = anchorSide;
  anchorSide = null;
  clearPaint();

  if (!from || !dragging) { dragging = false; return; }
  dragging = false;

  const side = gutter(event);
  if (!side || !sameColumn(side, from)) return;

  const a = Math.min(Number(from.dataset.line), Number(side.dataset.line));
  const b = Math.max(Number(from.dataset.line), Number(side.dataset.line));
  const start = a === Number(from.dataset.line) ? from : side;

  const url = '/r/' + start.dataset.review + '?box=' + encodeURIComponent(start.dataset.key) +
    (b > a ? '&to=' + b : '') + '#box';
  location.assign(url);
});

/* ---- comment box ----------------------------------------------------- */

document.addEventListener('toggle', (event) => {
  const details = event.target;
  if (!details.dataset || !details.dataset.fold) return;

  const main = document.getElementById('main');
  if (!main || !main.dataset.review) return;

  const closed = Array.from(document.querySelectorAll('details.file[data-fold]'))
    .filter((el) => !el.open)
    .map((el) => encodeURIComponent(el.dataset.fold));

  let value = main.dataset.review;
  for (const key of closed) {
    if (value.length + key.length + 1 > FOLD_LIMIT) break;
    value += '|' + key;
  }

  document.cookie = 'reviewd_folds=' + value + '; Path=/; Max-Age=31536000; SameSite=Lax';
}, true);

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-box]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return;

  const row = link.closest('.row');
  if (!row) return;

  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains('inline-box')) {
    existing.remove();
    return;
  }

  // Without a token the built form would be refused, so let the link navigate
  // to the box the server renders, which carries one. Degrading to the slower
  // path beats opening a comment box that cannot save.
  const carrier = document.getElementById('page-token');
  const token = carrier ? carrier.value : '';
  if (!token) return;

  event.preventDefault();

  const url = new URL(link.href);
  const key = url.searchParams.get('box') || '';
  const [sourceId, side, line, ...rest] = key.split(':');
  const path = rest.join(':');

  const holder = document.createElement('div');
  holder.className = 'threadrow inline-box';

  const form = document.createElement('form');
  form.method = 'post';
  form.action = url.pathname + '/threads';
  form.className = 'thread';

  for (const [name, value] of [
    ['token', token],
    ['sourceId', sourceId],
    ['path', path],
    ['side', side],
    ['line', line],
  ]) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  const id = 'inline-' + sourceId + '-' + side + '-' + line;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = 'Comment on ' + path + ' line ' + line;
  form.appendChild(label);

  const area = document.createElement('textarea');
  area.id = id;
  area.name = 'body';
  area.rows = 3;
  area.required = true;
  form.appendChild(area);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary';
  save.textContent = 'Save comment';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'quiet';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => { holder.remove(); link.focus(); });
  actions.append(save, cancel);
  form.appendChild(actions);

  holder.appendChild(form);
  row.after(holder);
  area.focus();
});
`
