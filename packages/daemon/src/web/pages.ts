import type { Kysely } from 'kysely'
import type { ReviewSummary } from '@reviewd/protocol'
import type { Database } from '../db/types.js'
import { html, raw, type SafeHtml } from './html.js'
import { anchorLineFor, buildRows, toHunks, type Row } from './hunks.js'
import { page, topBar } from './layout.js'

/**
 * Server-rendered review pages.
 *
 * Every file's rows are built from the blobs the client uploaded, so what a
 * reviewer reads is what was pushed rather than whatever the working tree says
 * at the moment they open the page.
 */

export function reviewListPage(reviews: ReviewSummary[]): SafeHtml {
  const body = html` ${topBar(`${reviews.length} open`)}
    <main>
      ${
    reviews.length === 0
      ? html`<p class="empty">No open reviews. An agent opens one when it has changes to show.</p>`
      : html`<ul class="reviews">
          ${reviews.map(
            (review) =>
              html`<li>
                <a href="/r/${review.reviewId}">
                  <div class="title">${review.title}</div>
                  <div class="meta">
                    ${age(review.ageSeconds)} ago &middot; ${review.filesChanged}
                    file${review.filesChanged === 1 ? '' : 's'} &middot; revision
                    ${review.snapshotSeq}
                    ${
                    review.sources.length > 1
                      ? html`&middot; ${review.sources.length} roots`
                      : raw('')
                  }
                    ${
                    review.threadsAwaitingHuman > 0
                      ? html` <span class="badge you">${review.threadsAwaitingHuman} for you</span>`
                      : raw('')
                  }
                    ${
                    review.status === 'approved'
                      ? html` <span class="badge approved">approved</span>`
                      : raw('')
                  }
                  </div>
                </a>
              </li>`,
          )}
        </ul>`
  }
    </main>`

  return page('reviewd', body)
}

/** A page that says why there is nothing to look at. */
export function messagePage(title: string, message: string): SafeHtml {
  return page(
    `${title} · reviewd`,
    html`${topBar(title)}
      <main><p class="empty">${message}</p></main>`,
  )
}

export interface FileView {
  changeId: string
  sourceLabel: string
  sourceId: string
  path: string
  changeType: string
  isBinary: boolean
  truncated: boolean
  oldText: string
  newText: string
}

export function reviewPage(review: ReviewSummary, files: FileView[]): SafeHtml {
  const body = html` ${topBar(
  review.title,
  html`<span class="meta">rev ${review.snapshotSeq}</span>`,
)}
    <main>
      ${
    files.length === 0
      ? html`<p class="empty">This revision changed nothing.</p>`
      : files.map((file) => fileBlock(file))
  }
    </main>`

  return page(`${review.title} · reviewd`, body)
}

function fileBlock(file: FileView): SafeHtml {
  const rows = file.isBinary || file.truncated ? [] : buildRows(file.oldText, file.newText)
  const hunks = toHunks(rows)

  return html`<details class="file" open>
    <summary>
      <span class="path">${file.path}</span>
      <span class="src">${file.sourceLabel}</span>
      <span class="badge">${file.changeType}</span>
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
                  ${hunk.rows.map((row) => diffRow(file, row))}
                `,
              )}
            </table>`
  }
  </details>`
}

function diffRow(file: FileView, row: Row): SafeHtml {
  const anchor = anchorLineFor(row)
  const sign = row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '

  // Every row carries what a comment on it would anchor to, so the script that
  // opens a comment box needs no lookup table.
  return html`<tr
    class="code ${row.kind}"
    data-source="${file.sourceId}"
    data-path="${file.path}"
    data-side="${anchor?.side ?? ''}"
    data-line="${anchor?.line ?? ''}"
  >
    <td class="num">${row.oldLine ?? ''}</td>
    <td class="num">${row.newLine ?? ''}</td>
    <td class="sign">${sign}</td>
    <td class="text">${row.text}</td>
  </tr>`
}

function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

/** Loads the current revision's files with both sides of their content. */
export async function loadFiles(db: Kysely<Database>, reviewId: string): Promise<FileView[]> {
  const snapshot = await db
    .selectFrom('snapshot')
    .selectAll()
    .where('review_id', '=', reviewId)
    .orderBy('seq', 'desc')
    .executeTakeFirst()

  if (!snapshot) return []

  const changes = await db
    .selectFrom('file_change')
    .innerJoin('source', 'source.id', 'file_change.source_id')
    .select([
      'file_change.id as change_id',
      'file_change.source_id',
      'file_change.path',
      'file_change.change_type',
      'file_change.is_binary',
      'file_change.truncated',
      'file_change.old_blob_id',
      'file_change.new_blob_id',
      'source.label as source_label',
      'source.ordinal',
    ])
    .where('file_change.snapshot_id', '=', snapshot.id)
    .orderBy('source.ordinal')
    .orderBy('file_change.path')
    .execute()

  const wanted = new Set<string>()
  for (const change of changes) {
    if (change.old_blob_id) wanted.add(change.old_blob_id)
    if (change.new_blob_id) wanted.add(change.new_blob_id)
  }

  const blobs = new Map<string, string>()
  if (wanted.size > 0) {
    const rows = await db
      .selectFrom('blob')
      .select(['id', 'bytes'])
      .where('id', 'in', [...wanted])
      .execute()

    for (const row of rows) {
      blobs.set(row.id, Buffer.from(row.bytes).toString('utf8'))
    }
  }

  return changes.map((change) => ({
    changeId: change.change_id,
    sourceId: change.source_id,
    sourceLabel: change.source_label,
    path: change.path,
    changeType: change.change_type,
    isBinary: change.is_binary === 1,
    truncated: change.truncated === 1,
    oldText: change.old_blob_id ? (blobs.get(change.old_blob_id) ?? '') : '',
    newText: change.new_blob_id ? (blobs.get(change.new_blob_id) ?? '') : '',
  }))
}
