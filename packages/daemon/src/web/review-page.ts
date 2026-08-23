import type { ReviewSummary, Thread } from '@reviewd/protocol'
import { html, raw, type SafeHtml } from './html.js'
import { anchorLineFor, buildRows, toHunks, type Row } from './hunks.js'
import { page, topBar } from './layout.js'
import type { FileView } from './pages.js'

/**
 * The review page: diff, threads anchored to their lines, and the controls a
 * reviewer acts through.
 *
 * Opening a comment box is a link rather than a script, so the page works with
 * nothing enabled and a box can be deep-linked. The script that ships only
 * saves the round trip.
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

  const body = html`
${topBar(review.title, html`<span class="meta">rev ${review.snapshotSeq}</span>`)}
<main class="${drafts > 0 ? 'with-tray' : ''}">
  ${sourceBar(review)}
  ${
    awaitingYou > 0
      ? html`<p class="callout">${awaitingYou} thread${awaitingYou === 1 ? '' : 's'} waiting on you.</p>`
      : raw('')
  }
  ${files.length === 0 ? html`<p class="empty">This revision changed nothing.</p>` : raw('')}
  ${files.map((file) => fileBlock(review, file, threads, open))}
  ${outdatedBlock(review, outdated)}
</main>
${tray(review, drafts)}`

  return page(`${review.title} · reviewd`, body, raw(`<script>${SCRIPT}</script>`))
}

function sourceBar(review: ReviewSummary): SafeHtml {
  if (review.sources.length === 0) return raw('')

  return html`<div class="sources">
  ${review.sources.map(
    (source) => html`<span class="source ${source.approved ? 'ok' : ''}">
      <span class="label">${source.label}</span>
      <span class="root">${source.rootPath}</span>
      ${source.approved ? html`<span class="badge approved">approved</span>` : raw('')}
    </span>`,
  )}
</div>`
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
    <span class="path">${file.path}</span>
    <span class="src">${file.sourceLabel}</span>
    <span class="badge">${file.changeType}</span>
    ${mine.length > 0 ? html`<span class="badge you">${mine.length}</span>` : raw('')}
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
                    <td colspan="4">${hunk.header}</td>
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
${here.map((thread) => threadRow(review, thread))}
${boxOpen && anchor ? newThreadRow(review, file, anchor) : raw('')}`
}

function diffRow(
  review: ReviewSummary,
  file: FileView,
  row: Row,
  anchor: { side: 'old' | 'new'; line: number } | null,
): SafeHtml {
  const sign = row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '

  if (!anchor) {
    return html`<tr class="code ${row.kind}">
  <td class="num">${row.oldLine ?? ''}</td>
  <td class="num">${row.newLine ?? ''}</td>
  <td class="sign">${sign}</td>
  <td class="text">${row.text}</td>
</tr>`
  }

  const target = `/r/${review.reviewId}?box=${encodeURIComponent(
    boxKey({ sourceId: file.sourceId, path: file.path, side: anchor.side, line: anchor.line }),
  )}#box`

  // A link rather than a script hook, so the box opens with nothing enabled
  // and a particular line can be deep-linked.
  return html`<tr class="code ${row.kind}">
  <td class="num">${row.oldLine ?? ''}</td>
  <td class="num">${row.newLine ?? ''}</td>
  <td class="sign">${sign}</td>
  <td class="text"><a class="rowlink" href="${raw(target)}" data-box>${row.text}</a></td>
</tr>`
}

function threadRow(review: ReviewSummary, thread: Thread): SafeHtml {
  return html`<tr class="threadrow">
  <td colspan="4">
    <div class="thread ${thread.state}" id="t-${thread.id}">
      ${thread.drifted ? html`<p class="drift">Code around this comment changed.</p>` : raw('')}
      ${thread.messages.map(
        (message) => html`<div class="msg ${message.author}">
          <span class="who">${message.author === 'human' ? 'you' : 'agent'}</span>
          ${message.submittedAt === null ? html`<span class="badge">draft</span>` : raw('')}
          <div class="body">${message.body}</div>
        </div>`,
      )}
      <form method="post" action="/r/${review.reviewId}/threads/${thread.id}/replies">
        <textarea name="body" rows="2" placeholder="Reply" required></textarea>
        <div class="actions">
          <button type="submit">Save reply</button>
          ${
            thread.state === 'active'
              ? html`<button
                  type="submit"
                  formaction="/r/${review.reviewId}/threads/${thread.id}/resolve"
                  formnovalidate
                  class="ghost"
                >
                  Resolve
                </button>`
              : html`<button
                  type="submit"
                  formaction="/r/${review.reviewId}/threads/${thread.id}/reopen"
                  formnovalidate
                  class="ghost"
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
  return html`<tr class="threadrow">
  <td colspan="4">
    <div class="thread new" id="box">
      <form method="post" action="/r/${review.reviewId}/threads">
        <input type="hidden" name="sourceId" value="${file.sourceId}">
        <input type="hidden" name="path" value="${file.path}">
        <input type="hidden" name="side" value="${anchor.side}">
        <input type="hidden" name="line" value="${anchor.line}">
        <textarea name="body" rows="3" placeholder="Comment on this line" autofocus required></textarea>
        <div class="actions">
          <button type="submit">Save draft</button>
          <a class="ghost" href="/r/${review.reviewId}">Cancel</a>
        </div>
      </form>
    </div>
  </td>
</tr>`
}

function outdatedBlock(review: ReviewSummary, outdated: Thread[]): SafeHtml {
  if (outdated.length === 0) return raw('')

  return html`<details class="file outdated">
  <summary>
    <span class="path">${outdated.length} outdated comment${outdated.length === 1 ? '' : 's'}</span>
    <span class="src">the code they were written on is gone</span>
  </summary>
  <table class="diff">
    ${outdated.map((thread) => threadRow(review, thread))}
  </table>
</details>`
}

/**
 * The submit controls.
 *
 * Nothing a reviewer writes reaches the agent until one of these buttons, which
 * is what keeps the agent from editing a file under a diff still being read.
 * Approving with threads open stays available, because that call is the
 * reviewer's to make.
 */
function tray(review: ReviewSummary, drafts: number): SafeHtml {
  const approved = review.sources.every((source) => source.approved) && review.sources.length > 0

  return html`<form class="tray" method="post" action="/r/${review.reviewId}/submit">
  <span class="count">
    ${
      drafts > 0
        ? html`${drafts} unsent comment${drafts === 1 ? '' : 's'}`
        : approved
          ? html`Approved`
          : html`Nothing unsent`
    }
  </span>
  <span class="spacer"></span>
  ${
    approved
      ? html`<button type="submit" formaction="/r/${review.reviewId}/unapprove" class="ghost">
          Unapprove
        </button>`
      : raw('')
  }
  <button type="submit" name="verdict" value="comment" class="ghost">Comment</button>
  <button type="submit" name="verdict" value="changes_requested">Request changes</button>
  <button type="submit" name="verdict" value="approved" class="primary">Approve</button>
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
  if (!row || row.nextElementSibling?.classList.contains('inline-box')) return;

  event.preventDefault();

  const url = new URL(link.href);
  const key = url.searchParams.get('box') || '';
  const [sourceId, side, line, ...rest] = key.split(':');

  const holder = document.createElement('tr');
  holder.className = 'threadrow inline-box';
  const cell = document.createElement('td');
  cell.colSpan = 4;
  holder.appendChild(cell);

  const form = document.createElement('form');
  form.method = 'post';
  form.action = url.pathname + '/threads';
  form.className = 'thread new';

  for (const [name, value] of [
    ['sourceId', sourceId],
    ['path', rest.join(':')],
    ['side', side],
    ['line', line],
  ]) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  const area = document.createElement('textarea');
  area.name = 'body';
  area.rows = 3;
  area.required = true;
  area.placeholder = 'Comment on this line';
  form.appendChild(area);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = 'Save draft';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => holder.remove());
  actions.append(save, cancel);
  form.appendChild(actions);

  cell.appendChild(form);
  row.after(holder);
  area.focus();
});
`
