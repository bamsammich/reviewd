import type { ReviewSummary, SourceSummary, Thread } from '@reviewd/protocol'
import { html, raw, type SafeHtml } from './html.js'
import { anchorLineFor, buildRows, toHunks, type Row } from './hunks.js'
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

export function reviewPage(
  review: ReviewSummary,
  files: FileView[],
  threads: Thread[],
  open?: OpenBox,
): SafeHtml {
  const drafts = threads.reduce(
    (count, thread) => count + thread.messages.filter((m) => m.submittedAt === null).length,
    0,
  )
  const awaitingYou = threads.filter((t) => t.state === 'active' && t.turn === 'human').length
  const outdated = threads.filter((t) => t.state === 'outdated')
  const grouped = groupBySource(review.sources, files)

  const body = html`
${topBar(review.title, html`<span class="rev">rev ${review.snapshotSeq}</span>`)}
<main id="main" class="review with-bar">
  <div class="rail">
    <h1 class="page-title">${review.title}</h1>
    ${scopeList(grouped)}
    ${coaching(threads.length, drafts, awaitingYou)}
  </div>

  <div class="files">
    ${files.length === 0 ? html`<p class="empty">This revision changed nothing.</p>` : raw('')}
    ${grouped.map((group) => sourceGroup(review, group, threads, open, grouped.length > 1))}
    ${outdatedBlock(review, outdated)}
  </div>
</main>
${submitBar(review, drafts, awaitingYou)}`

  return page(`${review.title} · reviewd`, body, raw(`<script>${SCRIPT}</script>`))
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
      : group.files.map((file) => fileBlock(review, file, threads, open))
  }
</section>`
}

function fileBlock(
  review: ReviewSummary,
  file: FileView,
  threads: Thread[],
  open?: OpenBox,
): SafeHtml {
  const rows = file.isBinary || file.truncated ? [] : buildRows(file.oldText, file.newText)
  const hunks = toHunks(rows)

  const mine = threads.filter(
    (thread) => thread.sourceId === file.sourceId && thread.path === file.path,
  )

  return html`<details class="file" open>
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
          : html`<table class="diff">
              ${hunks.map(
                (hunk) => html`
                  <tr class="hunk">
                    <td colspan="6">${hunk.header}</td>
                  </tr>
                  ${hunk.rows.map((row) => rowWithThreads(review, file, row, mine, open))}
                `,
              )}
            </table>`
  }
</details>`
}

function rowWithThreads(
  review: ReviewSummary,
  file: FileView,
  row: Row,
  threads: Thread[],
  open?: OpenBox,
): SafeHtml {
  const anchor = anchorLineFor(row)
  const here = anchor
    ? threads.filter(
        (thread) =>
          thread.state !== 'outdated' && thread.side === anchor.side && thread.line === anchor.line,
      )
    : []

  const boxOpen =
    anchor !== null &&
    open !== undefined &&
    open.sourceId === file.sourceId &&
    open.path === file.path &&
    open.side === anchor.side &&
    open.line === anchor.line

  return html`${diffRow(review, file, row, anchor)}
${here.map((thread) => threadRow(review, thread, false))}
${boxOpen && anchor ? newThreadRow(review, file, anchor) : raw('')}`
}

function diffRow(
  review: ReviewSummary,
  file: FileView,
  row: Row,
  anchor: { side: 'old' | 'new'; line: number } | null,
): SafeHtml {
  const sign = row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '

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

  // The code itself is plain text. Making it a link put the source of every
  // line into the accessibility tree as a control name, which told a screen
  // reader user nothing about what activating it would do.
  // Narrow screens get one number instead of two. The second column costs
  // width that code needs, and the number a reviewer quotes is whichever side
  // the row actually has.
  return html`<tr class="code ${row.kind}">
  <td class="num wide">${row.oldLine ?? ''}</td>
  <td class="num wide">${row.newLine ?? ''}</td>
  <td class="num narrow">${row.newLine ?? row.oldLine ?? ''}</td>
  <td class="act">${action}</td>
  <td class="sign" aria-hidden="true">${sign}</td>
  <td class="text">${row.text}</td>
</tr>`
}

function threadRow(review: ReviewSummary, thread: Thread, showLocation: boolean): SafeHtml {
  return html`<tr class="threadrow">
  <td colspan="6">
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
      <form method="post" action="/r/${review.reviewId}/threads/${thread.id}/replies">
        <label for="reply-${thread.id}">Reply</label>
        <textarea id="reply-${thread.id}" name="body" rows="2" required></textarea>
        <div class="actions">
          <button type="submit">Save reply</button>
          ${
            thread.state === 'active'
              ? html`<button
                  type="submit"
                  formaction="/r/${review.reviewId}/threads/${thread.id}/resolve"
                  formnovalidate
                  class="quiet"
                >
                  Resolve
                </button>`
              : html`<button
                  type="submit"
                  formaction="/r/${review.reviewId}/threads/${thread.id}/reopen"
                  formnovalidate
                  class="quiet"
                >
                  Reopen
                </button>`
          }
        </div>
      </form>
    </div>
  </td>
</tr>`
}

function newThreadRow(
  review: ReviewSummary,
  file: FileView,
  anchor: { side: 'old' | 'new'; line: number },
): SafeHtml {
  const id = `new-${file.sourceId}-${anchor.side}-${anchor.line}`

  return html`<tr class="threadrow">
  <td colspan="6">
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
  </td>
</tr>`
}

function outdatedBlock(review: ReviewSummary, outdated: Thread[]): SafeHtml {
  if (outdated.length === 0) return raw('')

  return html`<details class="file">
  <summary>
    <h3>${outdated.length} outdated comment${outdated.length === 1 ? '' : 's'}</h3>
    <span class="badge">code is gone</span>
  </summary>
  <table class="diff">
    ${outdated.map((thread) => threadRow(review, thread, true))}
  </table>
</details>`
}

/**
 * The submit controls.
 *
 * One primary action at a time. With unsent comments the primary action is
 * requesting changes, because that is what a reviewer who has written something
 * usually means; with nothing unsent it is approving, because that is what a
 * reviewer who has read and is satisfied usually means. The state line says
 * what approving does, since unblocking a commit is not visible from here.
 */
function submitBar(review: ReviewSummary, drafts: number, awaitingYou: number): SafeHtml {
  const approved = review.sources.length > 0 && review.sources.every((source) => source.approved)

  const state = approved
    ? html`<strong>Approved.</strong> The agent can commit these changes.`
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
          ? html`<button type="submit" formaction="/r/${review.reviewId}/unapprove" class="quiet">
              Unapprove
            </button>`
          : raw('')
      }
      ${
        drafts > 0
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
 * Opens a comment box without a round trip.
 *
 * Everything here is an enhancement: each link already works on its own, so a
 * failure to load leaves the page usable rather than inert.
 */
const SCRIPT = `
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-box]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return;

  const row = link.closest('tr');
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

  const holder = document.createElement('tr');
  holder.className = 'threadrow inline-box';
  const cell = document.createElement('td');
  cell.colSpan = 6;
  holder.appendChild(cell);

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

  cell.appendChild(form);
  row.after(holder);
  area.focus();
});
`
