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

export function reviewListPage(reviews: ReviewSummary[], fontScale = 1): SafeHtml {
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

  return page('reviewd', body, raw(''), fontScale)
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
          (source) =>
            html`<span title="${source.rootPath}"
              >${source.label || basenameOf(source.rootPath)}</span
            >`,
        )}
      </div>
      <div class="meta">
        ${review.fileCount} file${review.fileCount === 1 ? '' : 's'} &middot; rev
        ${review.snapshotSeq} &middot; ${age(review.ageSeconds)} ago
        ${
          // Named, not just counted. The heading above counts reviews waiting
          // on you and these count threads, so two bare "for you" numbers on
          // one screen read as the same tally disagreeing with itself.
          review.threadsAwaitingHuman > 0
            ? html` <span class="badge you"
                >${review.threadsAwaitingHuman} comment${review.threadsAwaitingHuman === 1 ? '' : 's'}
                for you</span
              >`
            : raw('')
        }
        ${review.status === 'approved' ? html` <span class="badge approved">approved</span>` : raw('')}
      </div>
    </a>
  </li>`
}

/** A page that says why there is nothing to look at. */
export function messagePage(title: string, message: string, fontScale = 1): SafeHtml {
  return page(
    `${title} · reviewd`,
    html`${topBar(title)}
      <main><p class="emptystate">${message}</p></main>`,
    raw(''),
    fontScale,
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

/** Compact enough to sit inside a line of metadata without wrapping it. */
export function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

/**
 * One commit of the revision being read.
 *
 * `files` counts what the commit changed rather than lines, because a line
 * tally means loading both sides of every file of every commit to render a
 * list nobody has clicked yet. The count comes from the rows themselves.
 */
export interface CommitView {
  id: string
  sha: string
  subject: string
  author: string
  committedAt: number
  files: number
}

/** The commits of the current revision, oldest first, or none. */
export async function loadCommits(db: Kysely<Database>, reviewId: string): Promise<CommitView[]> {
  const snapshot = await latestSnapshot(db, reviewId)
  if (!snapshot) return []

  const commits = await db
    .selectFrom('commit')
    .selectAll()
    .where('snapshot_id', '=', snapshot.id)
    .orderBy('ordinal')
    .execute()

  if (commits.length === 0) return []

  const counts = await db
    .selectFrom('file_change')
    .select(({ fn }) => ['commit_id', fn.countAll<number>().as('n')])
    .where('snapshot_id', '=', snapshot.id)
    .where(
      'commit_id',
      'in',
      commits.map((commit) => commit.id),
    )
    .groupBy('commit_id')
    .execute()

  const byCommit = new Map(counts.map((row) => [row.commit_id, row.n]))

  return commits.map((commit) => ({
    id: commit.id,
    sha: commit.sha,
    subject: commit.subject,
    author: commit.author,
    committedAt: commit.committed_at,
    files: byCommit.get(commit.id) ?? 0,
  }))
}

async function latestSnapshot(db: Kysely<Database>, reviewId: string) {
  return db
    .selectFrom('snapshot')
    .selectAll()
    .where('review_id', '=', reviewId)
    .orderBy('seq', 'desc')
    .executeTakeFirst()
}

/**
 * Loads the files of the current revision with both sides of their content.
 *
 * With a commit id, the files that commit alone changed; without one, the
 * combined change set. The two are different readings of one push rather than
 * a subset and its whole: a file taken from 1 to 2 to 3 across two commits is
 * one row in the combined set and one in each commit, holding different bytes.
 */
export async function loadFiles(
  db: Kysely<Database>,
  reviewId: string,
  commitId?: string | undefined,
): Promise<FileView[]> {
  const snapshot = await latestSnapshot(db, reviewId)

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
    .where((eb) =>
      commitId === undefined
        ? eb('file_change.commit_id', 'is', null)
        : eb('file_change.commit_id', '=', commitId),
    )
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
