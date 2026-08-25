import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { Kysely } from 'kysely'
import type {
  CreateReviewRequest,
  ReviewSummary,
  SnapshotManifest,
  SnapshotResult,
  SourceSummary,
} from '../protocol.js'
import { fingerprintsBySource } from '../fingerprint.js'
import type { Bus } from './bus.js'
import type { ResolvedConfig } from './config.js'
import { newId, now } from './db/ids.js'
import type { Database } from './db/types.js'

/**
 * Review, source, snapshot, and blob storage.
 *
 * Nothing here touches git. The client computes every diff and uploads the
 * content, so the daemon stores what it is handed and holds no opinion about
 * how the roots relate to each other.
 */

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413,
  ) {
    super(message)
    this.name = 'ReviewError'
  }
}

export interface Deps {
  db: Kysely<Database>
  config: ResolvedConfig
  /** Absent in unit tests that never wait on anything. */
  bus?: Bus
}

/** Every link the daemon emits is built here, never from a request's address. */
export function reviewUrl(config: ResolvedConfig, reviewId: string): string {
  return `${config.publicUrl}/r/${reviewId}`
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export async function createReview(
  { db, config }: Deps,
  request: CreateReviewRequest,
): Promise<ReviewSummary> {
  const reviewId = newId()
  const t = now()

  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('review')
      .values({
        id: reviewId,
        title: request.title,
        status: 'open',
        created_by: request.createdBy,
        created_at: t,
        last_activity_at: t,
        updated_at: t,
      })
      .execute()

    await tx
      .insertInto('source')
      .values(
        request.sources.map((source, index) => ({
          id: newId(),
          review_id: reviewId,
          label: source.label ?? (basename(source.path) || source.path),
          root_path: source.path,
          // A source with no base ref is a plain file set rather than a repo.
          vcs: (source.base === undefined ? 'none' : 'git') as 'git' | 'none',
          base_ref: source.base ?? null,
          ordinal: index,
        })),
      )
      .execute()
  })

  return summarize({ db, config }, reviewId)
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export async function summarize({ db, config }: Deps, reviewId: string): Promise<ReviewSummary> {
  const review = await db
    .selectFrom('review')
    .selectAll()
    .where('id', '=', reviewId)
    .executeTakeFirst()

  if (!review) {
    throw new ReviewError(`no review ${reviewId}`, 404)
  }

  const sources = await db
    .selectFrom('source')
    .selectAll()
    .where('review_id', '=', reviewId)
    .orderBy('ordinal')
    .execute()

  const latest = await db
    .selectFrom('snapshot')
    .selectAll()
    .where('review_id', '=', reviewId)
    .orderBy('seq', 'desc')
    .executeTakeFirst()

  const approvals = latest
    ? await db
        .selectFrom('approval')
        .select('source_id')
        .where('review_id', '=', reviewId)
        .where('snapshot_id', '=', latest.id)
        .execute()
    : []
  const approved = new Set(approvals.map((a) => a.source_id))

  const fileCount = latest
    ? await db
        .selectFrom('file_change')
        .select(({ fn }) => fn.countAll<number>().as('n'))
        .where('snapshot_id', '=', latest.id)
        .executeTakeFirst()
    : undefined

  const turns = await countThreadsByTurn(db, reviewId)

  const lastSubmission = await db
    .selectFrom('submission')
    .select('submitted_at')
    .where('review_id', '=', reviewId)
    .orderBy('submitted_at', 'desc')
    .executeTakeFirst()

  const sourceSummaries: SourceSummary[] = sources.map((source) => ({
    id: source.id,
    label: source.label,
    rootPath: source.root_path,
    vcs: source.vcs,
    baseRef: source.base_ref,
    approved: approved.has(source.id),
  }))

  return {
    reviewId: review.id,
    title: review.title,
    status: review.status,
    url: reviewUrl(config, review.id),
    createdAt: review.created_at,
    lastActivityAt: review.last_activity_at,
    ageSeconds: Math.max(0, Math.floor((now() - review.created_at) / 1000)),
    snapshotSeq: latest?.seq ?? 0,
    fileCount: fileCount?.n ?? 0,
    threadsAwaitingAgent: turns.agent,
    threadsAwaitingHuman: turns.human,
    lastSubmissionAt: lastSubmission?.submitted_at ?? 0,
    sources: sourceSummaries,
  }
}

/**
 * Counts live threads by whose turn it is.
 *
 * Turn is the author of the last submitted message, never a stored column, so
 * it cannot drift from the message list that holds the truth. A thread whose
 * messages are all drafts has not reached the agent and is counted nowhere.
 */
export async function countThreadsByTurn(
  db: Kysely<Database>,
  reviewId: string,
): Promise<{ human: number; agent: number }> {
  const rows = await db
    .selectFrom('thread')
    .innerJoin('message', 'message.thread_id', 'thread.id')
    .select(['thread.id as thread_id', 'message.author', 'message.seq'])
    .where('thread.review_id', '=', reviewId)
    .where('thread.state', '=', 'active')
    .where('message.submitted_at', 'is not', null)
    .orderBy('message.seq')
    .execute()

  const lastAuthor = new Map<string, 'human' | 'agent'>()
  for (const row of rows) {
    lastAuthor.set(row.thread_id, row.author)
  }

  let human = 0
  let agent = 0
  for (const author of lastAuthor.values()) {
    if (author === 'human') agent += 1
    else human += 1
  }

  return { human, agent }
}

export async function listReviews(
  { db, config }: Deps,
  filter: { status?: 'open' | 'approved'; rootPath?: string } = {},
): Promise<ReviewSummary[]> {
  let query = db.selectFrom('review').select('id').orderBy('created_at', 'desc')

  if (filter.status) {
    query = query.where('status', '=', filter.status)
  }

  if (filter.rootPath) {
    const roots = await db
      .selectFrom('source')
      .select('review_id')
      .where('root_path', '=', filter.rootPath)
      .execute()

    const ids = roots.map((r) => r.review_id)
    if (ids.length === 0) return []
    query = query.where('id', 'in', ids)
  }

  const rows = await query.execute()
  return Promise.all(rows.map((row) => summarize({ db, config }, row.id)))
}

// ---------------------------------------------------------------------------
// blobs
// ---------------------------------------------------------------------------

/** Ids the daemon lacks, so a snapshot uploads only what changed. */
export async function missingBlobs(db: Kysely<Database>, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []

  const present = await db.selectFrom('blob').select('id').where('id', 'in', ids).execute()
  const have = new Set(present.map((row) => row.id))
  return ids.filter((id) => !have.has(id))
}

/**
 * Stores content under its own hash.
 *
 * The id is verified rather than trusted: a client that computed it wrong would
 * otherwise poison every later snapshot that dedupes against it.
 */
export async function putBlob(
  { db, config }: Deps,
  id: string,
  bytes: Uint8Array,
): Promise<{ stored: boolean }> {
  if (bytes.byteLength > config.limits.max_blob_bytes) {
    throw new ReviewError(
      `blob is ${bytes.byteLength} bytes, over the ${config.limits.max_blob_bytes} limit`,
      413,
    )
  }

  const actual = sha256(bytes)
  if (actual !== id) {
    throw new ReviewError(`blob id ${id} does not match its content (${actual})`, 400)
  }

  // One statement rather than a SELECT that decides whether to INSERT. A
  // snapshot uploads in parallel, and two uploads of the same content used to
  // both find no row and both insert, the loser surfacing a primary key
  // violation as a 500. Whether the row was ours is the insert's own answer.
  const result = await db
    .insertInto('blob')
    .values({ id, bytes: Buffer.from(bytes), size: bytes.byteLength })
    .onConflict((oc) => oc.column('id').doNothing())
    .executeTakeFirst()

  return { stored: (result?.numInsertedOrUpdatedRows ?? 0n) > 0n }
}

export async function readBlob(
  db: Kysely<Database>,
  id: string,
): Promise<{ bytes: Buffer; size: number } | undefined> {
  const row = await db.selectFrom('blob').selectAll().where('id', '=', id).executeTakeFirst()
  if (!row) return undefined
  return { bytes: Buffer.from(row.bytes), size: row.size }
}

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

export async function createSnapshot(
  deps: Deps,
  reviewId: string,
  manifest: SnapshotManifest,
): Promise<SnapshotResult> {
  const { db, config } = deps

  const review = await db
    .selectFrom('review')
    .selectAll()
    .where('id', '=', reviewId)
    .executeTakeFirst()

  if (!review) throw new ReviewError(`no review ${reviewId}`, 404)

  if (manifest.files.length > config.limits.max_files_per_snapshot) {
    throw new ReviewError(
      `${manifest.files.length} files, over the ${config.limits.max_files_per_snapshot} limit`,
      413,
    )
  }

  const sources = await db
    .selectFrom('source')
    .selectAll()
    .where('review_id', '=', reviewId)
    .execute()
  const sourceIds = new Set(sources.map((s) => s.id))

  for (const file of manifest.files) {
    if (!sourceIds.has(file.sourceId)) {
      throw new ReviewError(
        `file ${file.path} names source ${file.sourceId}, not in this review`,
        400,
      )
    }
  }

  // Derived here, never accepted. A fingerprint on the wire is a claim about
  // bytes rather than a fact about them, and the gate rests on it: a client
  // that sent one could show the reviewer one change set and have the approval
  // cover another.
  const fingerprints = fingerprintsBySource(
    manifest.files,
    sources.map((source) => source.id),
  )

  // Referenced content must already be here. Accepting a manifest that points
  // at bytes nobody uploaded would leave a review that renders as empty files.
  const referenced = new Set<string>()
  for (const file of manifest.files) {
    if (file.oldBlobId) referenced.add(file.oldBlobId)
    if (file.newBlobId) referenced.add(file.newBlobId)
  }
  const absent = await missingBlobs(db, [...referenced])
  if (absent.length > 0) {
    throw new ReviewError(`manifest references ${absent.length} blob(s) not uploaded`, 409)
  }

  const snapshotId = newId()
  const t = now()

  // The number comes from inside the transaction because snapshot_review_seq
  // is unique: read outside it, two pushes racing on one review both see the
  // same predecessor, both claim the next number, and the loser fails on the
  // constraint instead of simply following.
  const seq = await db.transaction().execute(async (tx) => {
    const previous = await tx
      .selectFrom('snapshot')
      .selectAll()
      .where('review_id', '=', reviewId)
      .orderBy('seq', 'desc')
      .executeTakeFirst()

    const seq = (previous?.seq ?? 0) + 1

    await tx
      .insertInto('snapshot')
      .values({
        id: snapshotId,
        review_id: reviewId,
        seq,
        fingerprint: wholeReviewFingerprint(fingerprints),
        created_at: t,
      })
      .execute()

    await tx
      .insertInto('snapshot_source')
      .values(
        sources.map((source) => ({
          snapshot_id: snapshotId,
          source_id: source.id,
          fingerprint: fingerprints[source.id] as string,
        })),
      )
      .execute()

    if (manifest.files.length > 0) {
      await tx
        .insertInto('file_change')
        .values(
          manifest.files.map((file) => ({
            id: newId(),
            snapshot_id: snapshotId,
            source_id: file.sourceId,
            path: file.path,
            change_type: file.changeType,
            old_path: file.oldPath,
            old_blob_id: file.oldBlobId,
            new_blob_id: file.newBlobId,
            is_binary: file.isBinary ? (1 as const) : (0 as const),
            truncated: file.truncated ? (1 as const) : (0 as const),
          })),
        )
        .execute()
    }

    // A new snapshot supersedes any approval, which is the gate re-arming.
    await tx.deleteFrom('approval').where('review_id', '=', reviewId).execute()

    await tx
      .updateTable('review')
      .set({ last_activity_at: t, updated_at: t, status: 'open' })
      .where('id', '=', reviewId)
      .execute()

    return seq
  })

  // Re-anchoring runs after the transaction commits, so it reads the snapshot
  // it is anchoring against rather than a half-written one.
  const { reanchor } = await import('./reanchor.js')
  const { moved, outdated } = await reanchor(db, reviewId, snapshotId)

  // An open review page refreshes on this, which is what keeps a reviewer's
  // tab showing the revision they are about to approve rather than the one
  // that was current when they opened it.
  deps.bus?.publish({ kind: 'snapshot', reviewId, seq, at: t })

  return {
    seq,
    fileCount: manifest.files.length,
    threadsMoved: moved,
    threadsOutdated: outdated,
    url: reviewUrl(config, reviewId),
  }
}

/** Order-independent, so the same content hashes the same however it arrived. */
export function wholeReviewFingerprint(perSource: Record<string, string>): string {
  const parts = Object.entries(perSource)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sourceId, fingerprint]) => `${sourceId}:${fingerprint}`)

  return sha256(Buffer.from(parts.join('\n'), 'utf8'))
}

export async function touch(db: Kysely<Database>, reviewId: string): Promise<void> {
  const t = now()
  await db
    .updateTable('review')
    .set({ last_activity_at: t, updated_at: t })
    .where('id', '=', reviewId)
    .execute()
}
