import type { ReviewSummary, SourceSummary, Thread } from '../../protocol.js'
import { Palette, renderLine, type Token } from './highlight.js'
import { lineMarkKey, markRows, type LineMarks } from './words.js'
import { COMMENT_ICON, EXTEND_ICON, FOLDER_ICON, GIT_ICON } from './icons.js'
import { escapeHtml, html, raw, type SafeHtml } from './html.js'
import { renderMarkdown } from './markdown.js'
// anchorForHalf is gone from here: nothing in the renderer asks where a row is
// without also needing the file it is in, which is what a position carries.
import { buildRows, toHunks, toSplitRows, type Half, type Row, type SplitRow } from './hunks.js'
import { page, topBar } from './layout.js'
import { age, type FileView } from './pages.js'
import { basenameOf, displayPath } from './paths.js'
import { mintPageToken } from './tokens.js'
import { buildTree, filesOf, type TreeDirectory, type TreeFile, type TreeNode } from './tree.js'
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
/** A file's line diff and its size, which three parts of the page both want. */
interface Diff {
  rows: Row[]
  added: number
  removed: number
}

/**
 * Every file's diff, keyed by change id, built once for the whole render.
 *
 * The hunks, the size on the file header, and the size in the tree rail all
 * want the same line diff, and they render far apart. Kept here rather than on
 * FileView, which describes what the client uploaded: a diff stored beside the
 * text it came from goes quietly stale the moment anyone hands on a copy with
 * different text.
 */
type Diffs = ReadonlyMap<string, Diff>

function diffsFor(files: FileView[]): Diffs {
  return new Map(
    files.map((file) => {
      const rows = file.isBinary || file.truncated ? [] : buildRows(file.oldText, file.newText)

      return [
        file.changeId,
        {
          rows,
          added: rows.filter((row) => row.kind === 'added').length,
          removed: rows.filter((row) => row.kind === 'removed').length,
        },
      ]
    }),
  )
}

/** Empty rather than absent, so a caller never has to ask whether a file was found. */
const NO_DIFF: Diff = { rows: [], added: 0, removed: 0 }

interface Page {
  review: ReviewSummary
  threads: Thread[]
  open: OpenBox | undefined
  folded: ReadonlySet<string>
  palette: Palette
  diffs: Diffs
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

/*
 * There is no wrap setting, on purpose.
 *
 * One was built and taken out. Not wrapping means the column is as wide as the
 * file's longest line, so a single 200-character string sets the width of every
 * row and split view stops showing two halves at once, which is the only thing
 * split view is for. Measured on GitHub's own split diff: fifteen tables,
 * `table-layout: fixed`, the table exactly as wide as its container, zero of
 * them scrolling horizontally, and no wrap control anywhere on the page. Every
 * line wraps and the halves stay level.
 */

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
  const owed = threads.filter((t) => t.state === 'active' && t.turn === 'human')
  const awaitingYou = owed.length
  const outdated = threads.filter((t) => t.state === 'outdated')
  const grouped = groupBySource(review.sources, files)
  // Filled while the body renders, read after. Every colour the diff used, and
  // no others, reaches the stylesheet at the end.
  const palette = new Palette()
  const diffs = diffsFor(files)
  const page_: Page = { review, threads, open, folded, palette, diffs }

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
        data-submitted="${review.lastSubmissionAt}"
      />
      <div class="rail">
        <h1 class="page-title">${review.title}</h1>
        ${tally(
          [...diffs.values()].reduce((sum, diff) => sum + diff.added, 0),
          [...diffs.values()].reduce((sum, diff) => sum + diff.removed, 0),
        )}
        ${coaching(threads.length, drafts, awaitingYou)} ${commentIndex(threads)}
        ${scopeList(grouped, threads, diffs)}
      </div>

      <div class="files">
        ${
          files.length === 0
            ? html`<p class="emptystate">This revision changed nothing.</p>`
            : raw('')
        }
        ${viewToggle(review, view, rail)}
        ${grouped.map((group) => sourceGroup(page_, group, grouped.length > 1))}
        ${reviewLevelBlock(page_, threads)}
        ${outdatedBlock(page_, outdated)}
      </div>
    </main>
    ${submitBar(review, drafts, awaitingYou, owed[0])}`

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
  tree: TreeNode[]
}

/**
 * Splits the revision by source, and puts each source's files in the order its
 * tree draws them.
 *
 * The tree is built once here rather than again in the rail, because the rail
 * and the diff have to agree and the cheapest way to guarantee that is for
 * both to read the same walk.
 */
function groupBySource(sources: SourceSummary[], files: FileView[]): SourceGroup[] {
  return sources.map((source) => {
    const tree = buildTree(files.filter((file) => file.sourceId === source.id))
    return { source, tree, files: filesOf(tree) }
  })
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
function scopeList(groups: SourceGroup[], threads: Thread[], diffs: Diffs): SafeHtml {
  if (groups.length === 0) return raw('')

  const files = groups.reduce((total, group) => total + group.files.length, 0)

  return html`<nav class="scope" aria-labelledby="scope-heading" data-sources="${groups.length}">
    <div class="scopehead">
      <h2 id="scope-heading">
        ${files} file${files === 1 ? '' : 's'} in
        ${groups.length === 1 ? '1 place' : `${groups.length} places`}
      </h2>
      <!--
        Hidden until the script unhides it. A filter box that does nothing is
        worse than no filter box, and the filtering is the script's job.
      -->
      <div class="scopetools" hidden>
        <label class="visually-hidden" for="file-filter">Filter files</label>
        <input
          id="file-filter"
          class="filter"
          type="search"
          placeholder="Filter files"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
        <button type="button" class="foldall" aria-pressed="false">Collapse all</button>
      </div>
    </div>

    <!-- What the filter draws into, and what it says when nothing matches. -->
    <ul class="matches" hidden></ul>
    <p class="nomatch" role="status" hidden>No file matches.</p>

    <div class="branches">${groups.map((group) => sourceBranch(group, threads, diffs))}</div>
  </nav>`
}

function sourceBranch(group: SourceGroup, threads: Thread[], diffs: Diffs): SafeHtml {
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
    ${treeList(group.tree, threads, name, diffs)}
  </div>`
}

function treeList(
  nodes: TreeNode[],
  threads: Thread[],
  sourceLabel: string,
  diffs: Diffs,
): SafeHtml {
  if (nodes.length === 0) return raw('')

  return html`<ul class="tree">
    ${nodes.map(
      (node) =>
        html`<li>
          ${
            node.kind === 'directory'
              ? treeDirectory(node, threads, sourceLabel, diffs)
              : treeFile(node, threads, sourceLabel, diffs)
          }
        </li>`,
    )}
  </ul>`
}

function treeDirectory(
  node: TreeDirectory,
  threads: Thread[],
  sourceLabel: string,
  diffs: Diffs,
): SafeHtml {
  return html`<details class="dir" open>
    <summary>
      <span class="name">${node.name}</span>
      <span class="count" aria-hidden="true">${node.fileCount}</span>
      <span class="visually-hidden">
        ${node.fileCount} file${node.fileCount === 1 ? '' : 's'}
      </span>
    </summary>
    ${treeList(node.children, threads, sourceLabel, diffs)}
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

/**
 * How big a change is: two numbers, and the shape of the split.
 *
 * The numbers say how much. The bar says which way without anyone doing the
 * arithmetic, so a file that only grew and a file that was rewritten read
 * differently from across the room. It carries a ratio and not a size, which
 * is why the numbers stay next to it rather than behind it.
 *
 * The bar is left off in the tree rail, where the column is narrow enough that
 * a filename would be truncated to make room for a decoration.
 *
 * A file with no line diff renders nothing. Two zeroes on a binary file are
 * noise dressed as information.
 */
function tally(added: number, removed: number, options: { bar?: boolean } = {}): SafeHtml {
  if (added === 0 && removed === 0) return raw('')

  const share = Math.round((added / (added + removed)) * 100)

  return html`<span class="tally">
    <span class="plus" aria-hidden="true">+${added}</span>
    <span class="minus" aria-hidden="true">&minus;${removed}</span>
    ${
      options.bar === false
        ? raw('')
        : html`<span class="propbar" aria-hidden="true"
            ><i class="a" style="width:${share}%"></i><i class="d"></i
          ></span>`
    }
    <span class="visually-hidden">${added} added, ${removed} removed</span>
  </span>`
}

function treeFile(node: TreeFile, threads: Thread[], sourceLabel: string, diffs: Diffs): SafeHtml {
  const { file } = node
  const key = foldKey(file.sourceId, file.path)
  const cut = file.path.lastIndexOf('/')
  const directory = cut === -1 ? '' : file.path.slice(0, cut)
  const comments = threads.filter(
    (thread) =>
      thread.state !== 'outdated' &&
      thread.sourceId !== null &&
      thread.path !== null &&
      foldKey(thread.sourceId, thread.path) === key,
  ).length

  const mark = CHANGE_MARK[file.changeType] ?? '?'
  const diff = diffs.get(file.changeId) ?? NO_DIFF

  return html`<a
    class="leaf"
    href="#file-${key}"
    data-tree-file="${key}"
    data-path="${file.path}"
    data-dir="${directory}"
    data-source-label="${sourceLabel}"
  >
    <span class="mark ${file.changeType}" aria-hidden="true">${mark}</span>
    <span class="name">${node.name}</span>
    ${comments > 0 ? html`<span class="count" aria-hidden="true">${comments}</span>` : raw('')}
    ${tally(diff.added, diff.removed, { bar: false })}
    <span class="visually-hidden">
      ${file.changeType}${comments > 0 ? `, ${comments} comment${comments === 1 ? '' : 's'}` : ''}
    </span>
  </a>`
}

/**
 * The one line that says how to review, on the one review that needs telling.
 *
 * Only before the first thread exists. The two states it used to announce as
 * well, threads waiting on you and comments not sent, are both already on
 * screen twice: the index heading immediately below carries the count next to
 * the list itself, and the submit bar is fixed to the bottom of the viewport
 * and says the same thing from there. A banner restating a number it is sitting
 * on top of costs the top of every active review to tell the reader something
 * they are already looking at.
 *
 * What survives is the part nothing else says: which control opens a comment,
 * and that a saved comment goes nowhere until a verdict. A reviewer who does
 * not know the second one wonders why their comment vanished.
 */
function coaching(threadCount: number, drafts: number, awaitingYou: number): SafeHtml {
  if (threadCount > 0 || drafts > 0 || awaitingYou > 0) return raw('')

  // "Every line takes a comment" rather than "the icon is there", because on a
  // mouse the gutter is empty until you are on a row. Naming the icon still
  // does the work: it is what the reader recognises when it appears.
  return html`<p class="hint">
    Every line takes a comment: the <span class="key">${COMMENT_ICON}</span> in its gutter, or drag
    down the gutter to cover a block. <b>Nothing reaches the agent</b> until you choose a verdict.
  </p>`
}

/**
 * Every open comment, and where it is.
 *
 * The page had no answer to "where are the three threads waiting on me". The
 * counts said three, the bar said reply above, and the threads themselves were
 * at 5,000, 13,000 and 33,000 pixels of a review that is 34,000 tall. The tree
 * carried a per-file tally and nothing carried the comment on the change as a
 * whole, which has no file to hang a tally on.
 *
 * Owed first. A reader with a thread waiting on them has one job and the rest
 * of the list is reference.
 */
function commentIndex(threads: Thread[]): SafeHtml {
  const open = threads.filter((thread) => thread.state === 'active')
  if (open.length === 0) return raw('')

  const owed = open.filter((thread) => thread.turn === 'human')
  const rest = open.filter((thread) => thread.turn !== 'human')
  const ordered = [...owed, ...rest]

  const shown = ordered.slice(0, INDEX_SHOWN)
  const held = ordered.slice(INDEX_SHOWN)

  return html`<nav class="commentindex" aria-labelledby="comments-heading">
    <h2 id="comments-heading">
      ${open.length} open comment${open.length === 1 ? '' : 's'}
      ${owed.length > 0 ? html`<span class="badge you">${owed.length} for you</span>` : raw('')}
    </h2>
    <ul>
      ${shown.map((thread) => commentIndexEntry(thread))}
    </ul>
    ${
      held.length > 0
        ? html`<details class="more">
            <summary>${held.length} more</summary>
            <ul>
              ${held.map((thread) => commentIndexEntry(thread))}
            </ul>
          </details>`
        : raw('')
    }
  </nav>`
}

/**
 * How many entries the index lists before the rest go behind a disclosure.
 *
 * Measured with 21 open threads: at 73px each the list ran 1,652px and put the
 * file tree 1,840px into a rail that shows 737px, so the tree was unreachable
 * without scrolling past every card. Six is what fits above the tree while
 * still showing more than the two or three a short review has.
 *
 * Ordering does the rest of the work: threads waiting on the reader sort first,
 * so the six on show are the six that matter.
 */
const INDEX_SHOWN = 6

function commentIndexEntry(thread: Thread): SafeHtml {
  const last = thread.messages[thread.messages.length - 1]
  const anchored = thread.path !== null

  // Monospace belongs to the thing that is actually a path. A sentence set in
  // it alongside two filenames reads as a third filename.
  const where = anchored
    ? `${basenameOf(thread.path as string)}:${thread.line}${thread.endLine ? `–${thread.endLine}` : ''}`
    : 'The change as a whole'

  return html`<li>
    <a class="${thread.turn === 'human' ? 'owed' : ''}" href="#t-${thread.id}">
      <span class="where ${anchored ? 'at' : ''}">${where}</span>
      <span class="gist">${excerpt(last?.body ?? '')}</span>
      ${
        thread.turn === 'human'
          ? html`<span class="visually-hidden">waiting on you</span>`
          : raw('')
      }
    </a>
  </li>`
}

/**
 * The first sentence or so of a comment, flattened.
 *
 * Markdown in the body would come through as its own source text here, and a
 * list marker or a fence in a one-line summary reads as damage rather than as
 * formatting.
 */
function excerpt(body: string): string {
  const flat = body
    .replace(/[`*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > 90 ? `${flat.slice(0, 89).trimEnd()}…` : flat
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
  const diff = page.diffs.get(file.changeId) ?? NO_DIFF
  const hunks = toHunks(diff.rows)

  // Which words moved, worked out over the whole file rather than per hunk: a
  // block of changed lines is an edit whether or not a hunk boundary falls
  // inside it.
  const marks = markRows(diff.rows)

  const key = foldKey(file.sourceId, file.path)
  const mine = page.threads.filter(
    (thread) =>
      thread.sourceId !== null &&
      thread.path !== null &&
      foldKey(thread.sourceId, thread.path) === key,
  )

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
      ${tally(diff.added, diff.removed)}
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
                    ${toSplitRows(hunk.rows).map((row) => splitRow(page, file, row, mine, marks))}
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
function splitRow(
  page: Page,
  file: FileView,
  row: SplitRow,
  mine: Thread[],
  marks: LineMarks,
): SafeHtml {
  // Both halves, with nothing to deduplicate. A half now reports the side its
  // line number belongs to, so a thread matches exactly one of them. The
  // previous guard dropped the right half on context rows to stop a thread
  // rendering twice, which worked by hiding the real fault and would have
  // silently dropped any comment anchored to the new side of a context line.
  const attached = [...threadsAt(file, mine, row.left), ...threadsAt(file, mine, row.right)]
  const boxHere = [row.left, row.right].find((half) => isOpenOn(page.open, file, half))

  return html`<div class="row" data-unified="${row.unified}">
      ${half(page, file, row.left, 'left', marks)} ${half(page, file, row.right, 'right', marks)}
    </div>
    ${attached.map((thread) => threadBlock(page, thread, false))}
    ${boxHere && page.open ? newThreadBlock(page, file, page.open) : raw('')}`
}

/** The threads that hang from this row: same place, and still live. */
function threadsAt(file: FileView, threads: Thread[], side: Half): Thread[] {
  const here = positionAt(file, side)
  if (!here) return []

  return threads.filter((thread) => {
    if (thread.state === 'outdated') return false
    const position = positionOfThread(thread)
    return position !== undefined && samePlace(position, here)
  })
}

function isOpenOn(open: OpenBox | undefined, file: FileView, side: Half): boolean {
  const here = positionAt(file, side)
  return open !== undefined && here !== undefined && samePlace(open, here)
}

function half(
  page: Page,
  file: FileView,
  side: Half,
  which: 'left' | 'right',
  marks: LineMarks,
): SafeHtml {
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

  // draggable="false" because a browser drags a link by default, and that drag
  // swallows the pointer sequence the gutter selection is built on. Without it,
  // pressing on the + and pulling down starts a link drag, no pointerup reaches
  // the handler below, and the one column the page tells you to use is the one
  // where selecting a range does nothing.
  const action = extendable
    ? html`<a
        class="addnote extend"
        draggable="false"
        href="${raw(
          `/r/${review.reviewId}?box=${encodeURIComponent(keyAt(open.line))}&to=${here.line}#box`,
        )}"
        aria-label="Extend the comment down to line ${here.line}"
        title="Extend down to line ${here.line}"
        >${EXTEND_ICON}</a
      >`
    : html`<a
        class="addnote"
        draggable="false"
        href="${raw(`/r/${review.reviewId}?box=${encodeURIComponent(keyAt(here.line))}#box`)}"
        data-box
        aria-label="Comment on ${file.path} line ${here.line}"
        title="Comment on line ${here.line}"
        >${COMMENT_ICON}</a
      >`

  // Highlighted where we recognise the language and the line counts agreed,
  // and the raw text otherwise. `side.text` is escaped by the template;
  // renderLine escapes each token itself.
  const tokens = tokensForHalf(file, side, which)

  // An unhighlighted file still gets marks, as one colourless token, so a
  // language the highlighter does not know is not also a file whose edits are
  // invisible. renderLine escapes either way.
  const spans = marks.get(lineMarkKey(side.side, here.line)) ?? []
  const code =
    tokens !== undefined
      ? renderLine(tokens, page.palette, spans)
      : spans.length > 0
        ? renderLine([{ text: side.text, light: '', dark: '' }], page.palette, spans)
        : side.text

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
    <span class="t"${hangingIndent(side.text)}>${code}</span>
  </div>`
}

/** A tab counts as this many columns, matching the tab-size the diff sets. */
const TAB_COLUMNS = 4

/**
 * How far a wrapped line's continuation rows are pushed in.
 *
 * A wrapped line used to start every continuation at column zero, so the shape
 * of nested code was destroyed by the wrap. Measured at 1024px in split view,
 * where a half carries 52 characters: 14 of 27 lines wrapped, the worst to 11
 * rows, and `const pool =` / `createConnectionPool({` / `maximumConnections:`
 * all sat flush left with nothing saying which one opened the statement.
 *
 * The line's own leading whitespace plus two columns, so a continuation lands
 * just inside the code it belongs to and reads as a continuation rather than
 * as a new statement. Emitted only where it changes something, which is every
 * line that is indented at all.
 *
 * A negative text-indent against the matching padding is what makes it hang:
 * the first row is pulled back out to where the padding would otherwise put
 * it, and the literal leading whitespace positions it from there.
 */
function hangingIndent(text: string): SafeHtml {
  const leading = /^[ \t]*/.exec(text)?.[0] ?? ''
  if (leading.length === 0) return raw('')

  let columns = 0
  for (const character of leading) {
    columns += character === '\t' ? TAB_COLUMNS - (columns % TAB_COLUMNS) : 1
  }

  // Past a point the hang costs more width than the alignment returns, and a
  // deeply indented long line is exactly where width is already scarce.
  return raw(` style="--hang:${Math.min(columns, 12) + 2}ch"`)
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
    if (thread.state === 'outdated' || position === undefined) return false
    return isRange(position) && covers(position, here)
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
        showLocation && thread.path !== null
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
            <span class="when" title="${new Date(message.createdAt).toISOString()}"
              >${age(Math.max(0, Math.floor((Date.now() - message.createdAt) / 1000)))} ago</span
            >
            ${message.submittedAt === null ? html`<span class="badge draft">not sent</span>` : raw('')}
            <div class="body">${renderMarkdown(message.body)}</div>
          </div>`,
      )}
      <!--
        Reply and Resolve on one row. Stacked, they read as two unrelated
        controls of equal weight, and the one a thread waiting on you actually
        wants is the top one.
      -->
      <div class="threadactions">
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

/**
 * Comments about the review rather than about a line, and the box for writing
 * one.
 *
 * Below the diff, because that is when a reader has something to say about the
 * whole of it. Above the diff the box asked for a verdict before the evidence,
 * and sat in the way of the first file besides.
 *
 * The composer is closed until asked for. An empty textarea open on every
 * review is a permanent invitation to do something most readers do not want,
 * in the space belonging to the thing they came to read.
 */
function reviewLevelBlock(page: Page, threads: Thread[]): SafeHtml {
  const mine = threads.filter((thread) => thread.path === null && thread.state !== 'outdated')

  return html`<section class="overall">
    ${
      mine.length > 0
        ? html`<h3 class="overall-title">
              On the change as a whole
              <span class="badge">${mine.length}</span>
            </h3>
            ${mine.map((thread) => threadBlock(page, thread, false))}`
        : raw('')
    }
    <details class="compose">
      <summary>
        ${mine.length > 0 ? 'Add another comment on the whole change' : 'Comment on the whole change'}
      </summary>
      <form method="post" action="/r/${page.review.reviewId}/threads">
        ${tokenField(page)}
        <label for="overall-body">
          Something about the change that is not about one line
        </label>
        <textarea id="overall-body" name="body" rows="4" required aria-describedby="overall-help">
        </textarea>
        <p class="help" id="overall-help">
          The approach, the naming, a question about the shape of it. Nothing reaches the agent
          until you choose a verdict below.
        </p>
        <div class="actions">
          <button type="submit">Save comment</button>
        </div>
      </form>
    </details>
  </section>`
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
      ${other === 'split' ? 'Show side by side' : 'Show unified'}
    </a>
  </div>`
}

/**
 * The submit controls.
 *
 * One primary action at a time, and sometimes none. With unsent comments the
 * primary action is requesting changes, because that is what a reviewer who has
 * written something usually means; with nothing unsent and nothing owed it is
 * approving, because that is what a reviewer who has read and is satisfied
 * usually means. With threads still waiting on an answer neither button gets
 * the accent: the next thing to do is read them, not decide. The state line
 * says what approving does, since unblocking a commit is not visible from here.
 *
 * Approval is its own state rather than an extra button on the same row. A
 * reviewer who has just approved and gets back a highlighted Approve reads it
 * as a click that did not land, and the two other ways out of approval sitting
 * beside it invite the wrong one. What is left is the one thing still true:
 * the decision is made and the agent has not committed yet.
 */
function submitBar(
  review: ReviewSummary,
  drafts: number,
  awaitingYou: number,
  firstOwed: Thread | undefined,
): SafeHtml {
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
        ? // Not "reply above". A thread sits wherever its code sits, which on a
          // fifteen-file review measured here was 5,000, 13,000 and 33,600
          // pixels down a page 34,000 tall, in both directions from wherever
          // the reader had got to. The bar hands them the nearest one to start
          // on; the rail lists the rest.
          html`<strong>${awaitingYou} thread${awaitingYou === 1 ? '' : 's'} waiting on you.</strong>
            ${
              firstOwed
                ? html`<a href="#t-${firstOwed.id}">Go to the first</a>, or decide now.`
                : raw('Decide now, or read them first.')
            }`
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
              : // Approve loses the accent while the agent is waiting on an
                // answer. The bar was saying "3 threads waiting on you" and
                // putting the loudest control in the room on the one action
                // that ends the review without reading them.
                html`<button type="submit" name="verdict" value="changes_requested" class="quiet">
                    Request changes
                  </button>
                  <button
                    type="submit"
                    name="verdict"
                    value="approved"
                    class="${awaitingYou > 0 ? '' : 'primary'}"
                  >
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
  // The new markup arrives with the tools hidden and the tree unfiltered,
  // because the server does not know either was ever changed.
  restoreDrawer();
  window.scrollTo(0, offset);
  measureBar();

  /* The status lives in the header, which the line above just replaced with a
     freshly rendered one that does not have it. Put it back if it still
     applies, or it vanishes on the first refresh and the page goes back to
     looking live while it is not. */
  if (offline) showStale(blockedBefore());

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
 * dropped stream is not evidence: EventSource reconnects on its own and a blip
 * means nothing. Two failed fetches in a row is something to act on.
 *
 * What to do about it depends on which of two situations it is, and the page
 * can tell them apart by trying. Either the daemon is gone, in which case
 * nothing helps and saying so is the whole job. Or the daemon is fine and this
 * browser will not make background requests to it, in which case one thing
 * still works and the page should use it.
 *
 * That second case is real and not exotic. Claude Code's built-in browser
 * loads a review over a Tailscale name, runs its inline script and stylesheet,
 * and posts its forms, while refusing every fetch, XHR, image and stylesheet
 * request the page makes to that same origin. Measured, all four: blocked.
 * Only top-level navigation gets through.
 *
 * Which means the page there knows nothing. It cannot stream, cannot poll, and
 * has no way to learn that a revision landed. This first shipped as a timer
 * that reloaded every thirty seconds on that reasoning, and the reasoning was
 * wrong twice over. A page that moves under someone reading code is worse than
 * a page that waits, and reloading blind is not knowing something, it is
 * guessing on a schedule and hiding the guess.
 *
 * So the page says what it knows, which is that it cannot tell, and hands the
 * reviewer the one control that works. Nothing reloads unless they ask.
 */

/* Survives a reload, so a page coming back in a browser that blocks requests
   says so at once rather than waiting to fail twice again. */
const BLOCKED_KEY = 'reviewd_background_blocked';

let missedChecks = 0;
let offline = false;

function blockedBefore() {
  try {
    return sessionStorage.getItem(BLOCKED_KEY) === '1';
  } catch {
    /* Storage can be denied on its own terms. Falling back to live mode costs
       a browser that blocks requests its updates, and costs nothing else. */
    return false;
  }
}

function rememberBlocked(yes) {
  try {
    if (yes) sessionStorage.setItem(BLOCKED_KEY, '1');
    else sessionStorage.removeItem(BLOCKED_KEY);
  } catch {
    /* Nothing to do. See above. */
  }
}

function contactLost() {
  if (offline) return;
  offline = true;

  /* The page loaded, so the daemon answered a navigation seconds ago. A
     browser blocking background requests is the likelier reading of a failed
     poll than a daemon that died in between, and it is the one the reviewer
     can act on. */
  const blocked = blockedBefore();
  rememberBlocked(true);
  showStale(blocked);
}

/*
 * No backticks anywhere below this line: it all lives inside a template
 * literal, and one of them ends the string and turns the rest of the page
 * script into a syntax error.
 */

/*
 * Says how the page is keeping up, in the bar, next to the revision number.
 *
 * This was a pill floating over the diff, and floating was the mistake. A pill
 * suits something momentary; this state lasts for as long as the reviewer
 * stays in a browser that will not make background requests, which is the
 * whole session. A permanent overlay is a permanent hole in the code being
 * read, and moving it around only changes which lines it hides.
 *
 * It is also quiet on purpose. The page is not broken, it is keeping up a
 * slower way, and that is worth one small line rather than an interruption
 * after every reload.
 */
/*
 * This same review at 127.0.0.1, or nothing if we are already on a loopback
 * name.
 *
 * Same port and same path, because the daemon that served this page is the one
 * being addressed; only the name it is reached by changes. Built here rather
 * than sent by the daemon, which knows what it bound to and cannot know which
 * names a given browser will make requests to.
 */
function loopbackHere() {
  /* IPv6 arrives bracketed from location.hostname in some browsers and bare in
     others, so both spellings of ::1 reach the comparison below. */
  const host = location.hostname.toLowerCase().replace(/^[[]|]$/g, '');

  /* The names that already get the privilege, so the notice never offers to
     take the reviewer somewhere they are. Claude Code's desktop documentation
     names this set: localhost, any *.localhost subdomain, 127.0.0.1, and ::1.
     The subdomain form is easy to miss and is why this is a suffix test rather
     than three equality checks. */
  const loopbackName =
    host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.endsWith('.localhost');

  if (loopbackName) return null;

  const port = location.port ? ':' + location.port : '';
  return 'http://127.0.0.1' + port + location.pathname + location.search;
}

function showStale(knownBlocked) {
  if (document.getElementById('keeping-up')) return;

  const bar = document.querySelector('header.top');
  if (!bar) return;

  const note = document.createElement('span');
  note.id = 'keeping-up';
  note.className = 'keeping-up';
  /* status, not alert. This reads once when it appears and never interrupts
     again, which is right for something that describes the page rather than
     the review. */
  note.setAttribute('role', 'status');

  const what = document.createElement('span');
  what.className = 'what';
  /* What is true, not what the page intends to do about it. It cannot tell
     whether anything has changed, so it does not imply that it can. */
  what.textContent = 'Not live';
  note.appendChild(what);

  const sameReviewOnLoopback = loopbackHere();

  /* The full sentence lives here rather than on screen, so the bar stays a bar
     and the explanation is one hover or one screen reader away. */
  note.title = sameReviewOnLoopback
    ? 'This browser only makes background requests to localhost, so this page cannot see new revisions or comments. Open the same review on localhost and it updates by itself.'
    : knownBlocked
      ? 'This browser blocks background requests to reviewd, so this page cannot see new revisions or comments. Refresh to catch up.'
      : 'Lost contact with reviewd, so this page cannot see new revisions or comments. Refresh to catch up.';

  /*
   * The link that actually fixes it, when there is one.
   *
   * Measured in Claude Code's built-in browser: it permits background requests
   * to a loopback host and refuses them to every other name. Not to a loopback
   * address, to the name. The control was a server on 127.0.0.1:7788 reached
   * as localtest.me, a public name resolving to 127.0.0.1: allowed by address,
   * blocked by name. So editing hosts does not help and changing the address
   * bar does.
   *
   * Which browser this is, and whether it sits on the same machine as the
   * daemon, are both things the page cannot ask. It does not have to. The
   * offer only appears once background requests have already failed, and a
   * browser that makes them normally never sees it. The situation selects its
   * own audience, so the page can suggest instead of detect.
   */
  if (sameReviewOnLoopback) {
    const local = document.createElement('a');
    local.className = 'refresh';
    local.href = sameReviewOnLoopback;
    local.textContent = 'Open on localhost';
    note.appendChild(local);
  }

  /* A real control rather than a countdown.
     The reviewer is reading code. Moving the page under them on a timer, to
     fetch something the page has no evidence exists, takes a decision that is
     theirs and gives back a lost scroll position. This says the page is behind
     and lets them choose the moment. */
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'refresh';
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', () => location.reload());
  note.appendChild(refresh);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'dismiss';
  close.setAttribute('aria-label', 'Hide this notice');
  close.textContent = '×';
  close.addEventListener('click', () => note.remove());
  note.appendChild(close);

  bar.appendChild(note);
}

function contactMade() {
  missedChecks = 0;
  rememberBlocked(false);
  if (!offline) return;
  offline = false;

  const note = document.getElementById('keeping-up');
  if (note) note.remove();
}

/* Two in a row, so one dropped packet does not cry wolf. A browser already
   known to block requests does not get the benefit of the doubt twice. */
function checkFailed() {
  missedChecks += 1;
  if (missedChecks >= 2 || blockedBefore()) contactLost();
}

const liveMain = document.getElementById('main');

/* Reachable from a console on purpose. Diagnosing a page that had stopped
   updating meant opening a second EventSource from the console to guess at the
   state of the first, because this one was scoped inside the block below and
   nothing outside could see it. */
let liveStream = null;

if (liveMain && liveMain.dataset.review && 'EventSource' in window) {
  const source = new EventSource('/r/' + liveMain.dataset.review + '/events');
  liveStream = source;
  window.reviewdLive = {
    stream: source,
    state: () => ['connecting', 'open', 'closed'][source.readyState],
    blocked: blockedBefore,
    check: checkForChanges,
  };
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
    submitted: Number(carrier.dataset.submitted),
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
    now = {
      seq: review.snapshotSeq,
      awaiting: review.threadsAwaitingHuman,
      submitted: review.lastSubmissionAt,
    };
  } catch {
    checkFailed();
    return;
  }

  contactMade();

  if (now.seq !== was.seq) {
    settled = 'Now showing revision ' + now.seq + '.';
    notice(true, 'The agent pushed revision ' + now.seq + '. Updating this page.');
    land();
    return;
  }

  /* A submission made in another browser. The turn counts cannot see this:
     the reviewer's own note makes it the agent's turn, so it moves the agent
     count and not the human one, and a second note on a thread already the
     agent's moves neither. A review open on a laptop and a phone showed the
     laptop's notes on the phone only when an agent happened to write. */
  if (now.submitted !== was.submitted || now.awaiting !== was.awaiting) {
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

/* ---- how tall the submit bar actually is ------------------------------ */

/* The rail's height is whatever the two bars leave behind, and the submit bar
   is not a fixed height: it wraps to a second row on a narrow window. The CSS
   carries a guess as a fallback, which is wrong exactly when the bar wraps, so
   measure the real thing and let the stylesheet read it. */
function measureBar() {
  const bar = document.querySelector('form.bar');
  if (!bar) return;
  document.documentElement.style.setProperty(
    '--bar-height',
    bar.getBoundingClientRect().height + 'px',
  );
}

addEventListener('resize', measureBar, { passive: true });
measureBar();

/* ---- filtering the file tree ------------------------------------------ */

/*
 * Narrowing the drawer to the files you are looking for.
 *
 * The drawer listed every changed file and offered no way to reach one by
 * name, so a review of any size meant reading the whole tree to find the
 * entry you already knew you wanted.
 *
 * Matching runs over the whole path, so "web/mark" finds what typing either
 * half alone would. Measured on GitHub's own file tree: typing "markdown"
 * takes 21 rows to 3, and the directory chain collapses into one row carrying
 * the full path rather than staying nested. Same shape here, because a nested
 * chain of one-child directories is most of the drawer once a filter has
 * thrown the rest away.
 *
 * The controls only exist once this runs. A filter box that cannot filter is
 * worse than no filter box.
 */
/*
 * Everything is looked up per call rather than held.
 *
 * A live refresh replaces the whole of main, so any node captured here is
 * detached moments later and any listener bound to one stops firing. Measured:
 * the tools row came back hidden after the first poll and the filter went dead
 * without a single error in the console. Delegated listeners and fresh queries
 * survive the swap; restoreDrawer puts back what the new markup does not know.
 */
function drawer() {
  const scope = document.querySelector('.scope');
  if (!scope) return null;

  return {
    scope: scope,
    tools: scope.querySelector('.scopetools'),
    filter: scope.querySelector('.filter'),
    matches: scope.querySelector('ul.matches'),
    nomatch: scope.querySelector('.nomatch'),
    branches: scope.querySelector('.branches'),
    foldall: scope.querySelector('.foldall'),
  };
}

/* One row per match, grouped under the directory holding them, in the order
   the tree already put them in. */
function drawMatches(parts, query) {
  const manySources = parts.scope.dataset.sources !== '1';
  const hits = Array.from(parts.branches.querySelectorAll('a.leaf')).filter((leaf) =>
    (leaf.dataset.path || '').toLowerCase().includes(query),
  );

  let lastGroup = null;
  parts.matches.replaceChildren();

  for (const leaf of hits) {
    const where =
      (manySources ? leaf.dataset.sourceLabel + ' / ' : '') + (leaf.dataset.dir || '.');

    if (where !== lastGroup) {
      lastGroup = where;
      const head = document.createElement('li');
      head.className = 'matchdir';
      head.textContent = where;
      parts.matches.appendChild(head);
    }

    const row = document.createElement('li');
    row.appendChild(leaf.cloneNode(true));
    parts.matches.appendChild(row);
  }

  return hits.length;
}

function applyFilter() {
  const parts = drawer();
  if (!parts || !parts.filter) return;

  const query = parts.filter.value.trim().toLowerCase();

  if (!query) {
    parts.branches.hidden = false;
    parts.matches.hidden = true;
    parts.nomatch.hidden = true;
    parts.matches.replaceChildren();
    return;
  }

  const found = drawMatches(parts, query);
  parts.branches.hidden = true;
  parts.matches.hidden = found === 0;
  parts.nomatch.hidden = found !== 0;
}

/* What the reviewer set, which the server does not know and a refresh drops. */
let drawerFilter = '';
let drawerCollapsed = false;

function restoreDrawer() {
  const parts = drawer();
  if (!parts || !parts.tools) return;

  parts.tools.hidden = false;
  parts.filter.value = drawerFilter;

  if (drawerCollapsed) {
    for (const dir of parts.scope.querySelectorAll('details.dir')) dir.open = false;
    parts.foldall.setAttribute('aria-pressed', 'true');
    parts.foldall.textContent = 'Expand all';
  }

  applyFilter();
}

document.addEventListener('input', (event) => {
  const target = event.target;
  if (!target.classList || !target.classList.contains('filter')) return;
  drawerFilter = target.value;
  applyFilter();
});

/* Escape clears rather than leaving the drawer filtered behind you. */
document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (event.key !== 'Escape') return;
  if (!target.classList || !target.classList.contains('filter') || !target.value) return;
  target.value = '';
  drawerFilter = '';
  applyFilter();
});

document.addEventListener('click', (event) => {
  const button = event.target.closest ? event.target.closest('.foldall') : null;
  if (!button) return;

  drawerCollapsed = button.getAttribute('aria-pressed') === 'false';
  for (const dir of document.querySelectorAll('.scope details.dir')) {
    dir.open = !drawerCollapsed;
  }
  button.setAttribute('aria-pressed', drawerCollapsed ? 'true' : 'false');
  button.textContent = drawerCollapsed ? 'Expand all' : 'Collapse all';
});

restoreDrawer();

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
