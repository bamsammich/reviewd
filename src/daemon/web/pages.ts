import type { Kysely } from 'kysely'
import type { ReviewSummary } from '../../protocol.js'
import type { Database } from '../db/types.js'
import { languageFor, tokenize, type Token } from './highlight.js'
import { html, raw, type SafeHtml } from './html.js'
import { splitLines } from './hunks.js'
import { page, topBar } from './layout.js'
import { basenameOf } from './paths.js'

/**
 * Server-rendered review pages.
 *
 * Every file's rows are built from the blobs the client uploaded, so what a
 * reviewer reads is what was pushed rather than whatever the working tree says
 * at the moment they open the page.
 */

export function reviewListPage(reviews: ReviewSummary[]): SafeHtml {
  const waiting = reviews.filter((review) => review.threadsAwaitingHuman > 0).length

  const body = html`${topBar(reviews.length === 0 ? 'nothing open' : `${reviews.length} open`)}
<main id="main">
  <h1 class="page-title">
    ${reviews.length === 0 ? 'No open reviews' : `${reviews.length} open review${reviews.length === 1 ? '' : 's'}`}
    ${waiting > 0 ? html`<span class="badge you">${waiting} waiting on you</span>` : raw('')}
  </h1>
  ${
    reviews.length === 0
      ? html`<p class="emptystate">
          An agent opens a review when it has changes to show, and sends you a link.
        </p>`
      : html`<ul class="reviews">
          ${reviews.map((review) => reviewCard(review))}
        </ul>`
  }
</main>`

  return page('reviewd', body)
}

/**
 * One review in the list.
 *
 * The roots come before the counts, because the first thing worth knowing
 * about a review is which code it covers.
 */
function reviewCard(review: ReviewSummary): SafeHtml {
  return html`<li>
  <a href="/r/${review.reviewId}">
    <div class="title">${review.title}</div>
    <div class="roots">
      ${review.sources.map(
        (source) => html`<span title="${source.rootPath}"
          >${source.label || basenameOf(source.rootPath)}</span
        >`,
      )}
    </div>
    <div class="meta">
      ${review.fileCount} file${review.fileCount === 1 ? '' : 's'} &middot; rev
      ${review.snapshotSeq} &middot; ${age(review.ageSeconds)} ago
      ${
        review.threadsAwaitingHuman > 0
          ? html` <span class="badge you">${review.threadsAwaitingHuman} for you</span>`
          : raw('')
      }
      ${review.status === 'approved' ? html` <span class="badge approved">approved</span>` : raw('')}
    </div>
  </a>
</li>`
}

/** A page that says why there is nothing to look at. */
export function messagePage(title: string, message: string): SafeHtml {
  return page(
    `${title} · reviewd`,
    html`${topBar(title)}
      <main><p class="emptystate">${message}</p></main>`,
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
  /** One token array per line, absent when this file renders plain. */
  oldTokens?: Token[][] | undefined
  newTokens?: Token[][] | undefined
  /** sha256 of each side's content, which is what the token cache keys on. */
  oldBlobId?: string | undefined
  newBlobId?: string | undefined
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

  const views: FileView[] = changes.map((change) => ({
    changeId: change.change_id,
    sourceId: change.source_id,
    sourceLabel: change.source_label,
    path: change.path,
    changeType: change.change_type,
    isBinary: change.is_binary === 1,
    truncated: change.truncated === 1,
    oldText: change.old_blob_id ? (blobs.get(change.old_blob_id) ?? '') : '',
    newText: change.new_blob_id ? (blobs.get(change.new_blob_id) ?? '') : '',
    oldBlobId: change.old_blob_id ?? undefined,
    newBlobId: change.new_blob_id ?? undefined,
  }))

  await attachHighlighting(views)
  return views
}

/**
 * Tokenises both sides of every file that has a language we know.
 *
 * Here rather than in the renderer because loading a grammar is asynchronous
 * and rendering is not, and because a page wants every file tokenised before
 * it writes any of them.
 */
async function attachHighlighting(views: FileView[]): Promise<void> {
  await Promise.all(
    views.map(async (view) => {
      if (view.isBinary || view.truncated) return

      const language = languageFor(view.path)
      if (!language) return

      view.oldTokens = await tokenize(
        view.oldText,
        language,
        splitLines(view.oldText).length,
        view.oldBlobId,
      )
      view.newTokens = await tokenize(
        view.newText,
        language,
        splitLines(view.newText).length,
        view.newBlobId,
      )
    }),
  )
}
