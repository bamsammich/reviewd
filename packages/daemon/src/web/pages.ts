import type { Kysely } from 'kysely'
import type { ReviewSummary } from '@reviewd/protocol'
import type { Database } from '../db/types.js'
import { html, raw, type SafeHtml } from './html.js'
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
