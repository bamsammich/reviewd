import type { ReviewSummary, SourceSummary, Thread } from '../../protocol.js'
import { Palette, renderLine, type Token } from './highlight.js'
import { html, raw, type SafeHtml } from './html.js'
import {
  anchorForHalf,
  buildRows,
  toHunks,
  toSplitRows,
  type Half,
  type SplitRow,
} from './hunks.js'
import { page, topBar } from './layout.js'
import type { FileView } from './pages.js'
import { basenameOf, displayPath } from './paths.js'

/**
 * The review page.
 *
 * Two questions have to be answerable without scrolling or guessing: what am I
 * looking at, and how do I say something about it. The scope list answers the
 * first by naming every root up front, and a visible control on every line
 * answers the second.
 */

/** Which row currently has an open comment box, if any. */
export interface OpenBox {
  sourceId: string
  path: string
  side: 'old' | 'new'
  line: number
}

export function parseOpenBox(value: string | undefined): OpenBox | undefined {
  if (!value) return undefined

  const [sourceId, side, line, ...pathParts] = value.split(':')
  const path = pathParts.join(':')

  if (!sourceId || !path || (side !== 'old' && side !== 'new')) return undefined

  const parsed = Number(line)
  if (!Number.isInteger(parsed) || parsed < 1) return undefined

  return { sourceId, path, side, line: parsed }
}

export function boxKey(box: OpenBox): string {
  return `${box.sourceId}:${box.side}:${box.line}:${box.path}`
}

export type ViewMode = 'split' | 'unified'

export function parseViewMode(value: string | undefined): ViewMode {
  return value === 'unified' ? 'unified' : 'split'
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

  const body = html`
${topBar(review.title, html`<span class="rev">rev ${review.snapshotSeq}</span>`)}
<main id="main" class="review with-bar view-${view}" data-review="${review.reviewId}">
  <div class="rail">
    <h1 class="page-title">${review.title}</h1>
    ${scopeList(grouped)}
    ${coaching(threads.length, drafts, awaitingYou)}
  </div>

  <div class="files">
    ${
      files.length === 0
        ? html`<p class="emptystate">This revision changed nothing.</p>`
        : raw('')
    }
    ${viewToggle(review, view)}
    ${grouped.map((group) =>
      sourceGroup(review, group, threads, open, grouped.length > 1, folded, palette),
    )}
    ${outdatedBlock(review, outdated)}
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
function scopeList(groups: SourceGroup[]): SafeHtml {
  if (groups.length === 0) return raw('')

  return html`<nav class="scope" aria-labelledby="scope-heading">
  <h2 id="scope-heading">
    Reviewing ${groups.length === 1 ? '1 place' : `${groups.length} places`}
  </h2>
  <ul>
    ${groups.map(
      (group) => html`<li>
        <a
          class="root ${group.source.approved ? 'ok' : ''}"
          href="#src-${group.source.id}"
          title="${group.source.rootPath}"
          aria-label="${`${group.source.label || basenameOf(group.source.rootPath)}, ${
            group.files.length
          } file${group.files.length === 1 ? '' : 's'}${
            group.source.approved ? ', approved' : ''
          }, at ${group.source.rootPath}`}"
        >
          <span class="name">${group.source.label || basenameOf(group.source.rootPath)}</span>
          ${
            group.source.approved
              ? html`<span class="badge approved">approved</span>`
              : raw('')
          }
          <span class="count"
            >${group.files.length} file${group.files.length === 1 ? '' : 's'}</span
          >
          <span class="path">${displayPath(group.source.rootPath)}</span>
        </a>
      </li>`,
    )}
  </ul>
</nav>`
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

function sourceGroup(
  review: ReviewSummary,
  group: SourceGroup,
  threads: Thread[],
  open: OpenBox | undefined,
  showHeading: boolean,
  folded: ReadonlySet<string>,
  palette: Palette,
): SafeHtml {
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
      : group.files.map((file) => fileBlock(review, file, threads, folded, palette, open))
  }
</section>`
}

function fileBlock(
  review: ReviewSummary,
  file: FileView,
  threads: Thread[],
  folded: ReadonlySet<string>,
  palette: Palette,
  open?: OpenBox,
): SafeHtml {
  const rows = file.isBinary || file.truncated ? [] : buildRows(file.oldText, file.newText)
  const hunks = toHunks(rows)

  const mine = threads.filter(
    (thread) => thread.sourceId === file.sourceId && thread.path === file.path,
  )

  // A collapsed file stays collapsed across renders, except when the comment
  // box the reviewer just opened lives inside it. Honouring the fold there
  // would hide the box they are trying to type into.
  const key = foldKey(file.sourceId, file.path)
  const holdsBox = open?.sourceId === file.sourceId && open.path === file.path
  const expanded = holdsBox || !folded.has(key)

  return html`<details class="file" data-fold="${key}" ${expanded ? raw('open') : raw('')}>
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
                  ${toSplitRows(hunk.rows).map((row) =>
                    splitRow(review, file, row, mine, palette, open),
                  )}
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
function splitRow(
  review: ReviewSummary,
  file: FileView,
  row: SplitRow,
  threads: Thread[],
  palette: Palette,
  open?: OpenBox,
): SafeHtml {
  // Both halves, with nothing to deduplicate. A half now reports the side its
  // line number belongs to, so a thread matches exactly one of them. The
  // previous guard dropped the right half on context rows to stop a thread
  // rendering twice, which worked by hiding the real fault and would have
  // silently dropped any comment anchored to the new side of a context line.
  const attached = [...threadsAt(threads, row.left), ...threadsAt(threads, row.right)]

  const boxHere = [row.left, row.right].find((half) => isOpenOn(open, file, half))

  return html`<div class="row" data-unified="${row.unified}">
  ${half(review, file, row.left, 'left', palette)}
  ${half(review, file, row.right, 'right', palette)}
</div>
${attached.map((thread) => threadBlock(review, thread, false))}
${boxHere ? newThreadBlock(review, file, anchorForHalf(boxHere)!) : raw('')}`
}

function threadsAt(threads: Thread[], side: Half): Thread[] {
  const anchor = anchorForHalf(side)
  if (!anchor) return []

  return threads.filter(
    (thread) =>
      thread.state !== 'outdated' && thread.side === anchor.side && thread.line === anchor.line,
  )
}

function isOpenOn(open: OpenBox | undefined, file: FileView, side: Half): boolean {
  const anchor = anchorForHalf(side)
  if (!open || !anchor) return false

  return (
    open.sourceId === file.sourceId &&
    open.path === file.path &&
    open.side === anchor.side &&
    open.line === anchor.line
  )
}

function half(
  review: ReviewSummary,
  file: FileView,
  side: Half,
  which: 'left' | 'right',
  palette: Palette,
): SafeHtml {
  if (side.kind === 'empty') {
    return html`<div class="side ${which} empty" aria-hidden="true"></div>`
  }

  const anchor = anchorForHalf(side)
  const sign = side.kind === 'added' ? '+' : side.kind === 'removed' ? '-' : ' '

  const action = anchor
    ? html`<a
        class="addnote"
        href="${raw(
          `/r/${review.reviewId}?box=${encodeURIComponent(
            boxKey({
              sourceId: file.sourceId,
              path: file.path,
              side: anchor.side,
              line: anchor.line,
            }),
          )}#box`,
        )}"
        data-box
        aria-label="Comment on ${file.path} line ${anchor.line}"
        title="Comment on line ${anchor.line}"
        >+</a
      >`
    : raw('')

  // Highlighted where we recognise the language and the line counts agreed,
  // and the raw text otherwise. `side.text` is escaped by the template;
  // renderLine escapes each token itself.
  const tokens = tokensForHalf(file, side, which)
  const code = tokens ? renderLine(tokens, palette) : side.text

  // The code itself is plain text. Making it a link put the source of every
  // line into the accessibility tree as a control name, which told a screen
  // reader user nothing about what activating it would do.
  return html`<div class="side ${which} ${side.kind}">
  <span class="n">${side.line ?? ''}</span>
  <span class="act">${action}</span>
  <span class="sign" aria-hidden="true">${sign}</span>
  <span class="t">${code}</span>
</div>`
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

function threadBlock(review: ReviewSummary, thread: Thread, showLocation: boolean): SafeHtml {
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
        (message) => html`<div class="msg">
          <span class="who">${message.author === 'human' ? 'you' : 'agent'}</span>
          ${message.submittedAt === null ? html`<span class="badge draft">not sent</span>` : raw('')}
          <div class="body">${message.body}</div>
        </div>`,
      )}
      <details class="reply">
        <summary>Reply</summary>
        <form method="post" action="/r/${review.reviewId}/threads/${thread.id}/replies">
          <label class="visually-hidden" for="reply-${thread.id}">
            Reply to this comment
          </label>
          <textarea id="reply-${thread.id}" name="body" rows="2" required></textarea>
          <div class="actions">
            <button type="submit" class="primary">Save reply</button>
          </div>
        </form>
      </details>
      <div class="actions">
        <form
          method="post"
          action="/r/${review.reviewId}/threads/${thread.id}/${
            thread.state === 'active' ? 'resolve' : 'reopen'
          }"
        >
          <button type="submit" class="quiet">
            ${thread.state === 'active' ? 'Resolve' : 'Reopen'}
          </button>
        </form>
      </div>
    </div>
</div>`
}

function newThreadBlock(
  review: ReviewSummary,
  file: FileView,
  anchor: { side: 'old' | 'new'; line: number },
): SafeHtml {
  const id = `new-${file.sourceId}-${anchor.side}-${anchor.line}`

  return html`<div class="threadrow">
    <div class="thread" id="box">
      <form method="post" action="/r/${review.reviewId}/threads">
        <input type="hidden" name="sourceId" value="${file.sourceId}">
        <input type="hidden" name="path" value="${file.path}">
        <input type="hidden" name="side" value="${anchor.side}">
        <input type="hidden" name="line" value="${anchor.line}">
        <label for="${id}">Comment on ${file.path} line ${anchor.line}</label>
        <textarea id="${id}" name="body" rows="3" autofocus required></textarea>
        <div class="actions">
          <button type="submit" class="primary">Save comment</button>
          <a class="btn quiet" href="/r/${review.reviewId}">Cancel</a>
        </div>
      </form>
    </div>
</div>`
}

function outdatedBlock(review: ReviewSummary, outdated: Thread[]): SafeHtml {
  if (outdated.length === 0) return raw('')

  return html`<details class="file">
  <summary>
    <h3>${outdated.length} outdated comment${outdated.length === 1 ? '' : 's'}</h3>
    <span class="badge">code is gone</span>
  </summary>
  <div class="diff">
    ${outdated.map((thread) => threadBlock(review, thread, true))}
  </div>
</details>`
}

/**
 * Split against unified.
 *
 * Hidden below the breakpoint where split stops fitting, because an option
 * that cannot be honored is worse than no option. The stylesheet stacks the
 * halves there whatever the stored preference says.
 */
function viewToggle(review: ReviewSummary, view: ViewMode): SafeHtml {
  const other: ViewMode = view === 'split' ? 'unified' : 'split'

  return html`<div class="viewtoggle">
  <a class="btn quiet" href="/r/${review.reviewId}?view=${other}">
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
      ? html`<strong>${drafts} comment${drafts === 1 ? '' : 's'} not sent.</strong>
          Choose how to send them.`
      : awaitingYou > 0
        ? html`<strong>${awaitingYou} waiting on you.</strong> Reply above, or decide now.`
        : html`Approving lets the agent commit.`

  return html`<form class="bar" method="post" action="/r/${review.reviewId}/submit">
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
  const response = await fetch(location.href, { headers: { 'x-reviewd-refresh': '1' } });
  if (!response.ok) return;

  const next = new DOMParser().parseFromString(await response.text(), 'text/html');
  const main = document.getElementById('main');
  const bar = document.querySelector('form.bar');
  const nextMain = next.getElementById('main');
  const nextBar = next.querySelector('form.bar');
  if (!main || !nextMain) return;

  const replies = openReplies();
  const offset = window.scrollY;

  main.innerHTML = nextMain.innerHTML;
  if (bar && nextBar) bar.outerHTML = nextBar.outerHTML;

  restoreReplies(replies);
  window.scrollTo(0, offset);
  notice(false);
}

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

function notice(show) {
  let pill = document.getElementById('live-notice');
  if (!show) { if (pill) pill.remove(); return; }
  if (pill) return;

  pill = document.createElement('div');
  pill.id = 'live-notice';
  pill.className = 'live-notice';
  pill.setAttribute('role', 'status');
  pill.textContent = 'New reply. Updating when you stop typing.';
  document.body.appendChild(pill);
}

const liveMain = document.getElementById('main');
if (liveMain && liveMain.dataset.review && 'EventSource' in window) {
  const source = new EventSource('/r/' + liveMain.dataset.review + '/events');
  source.addEventListener('threads', land);
  source.addEventListener('gone', () => { source.close(); location.reload(); });
}

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
