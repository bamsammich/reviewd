import type { Kysely } from 'kysely'
import type { GateResponse, ReleaseResult } from '@reviewd/protocol'
import { now } from './db/ids.js'
import type { Database } from './db/types.js'
import { reviewUrl, ReviewError, type Deps } from './reviews.js'

/**
 * The commit gate and the release that ends a review.
 *
 * Allow requires one thing: an approval whose root and fingerprint match what
 * the hook computed. Thread state is reported and never consulted, because an
 * explicit approval already says the reviewer looked and said yes, and deriving
 * that from the absence of comments makes "not looked at yet" and "approved"
 * the same state.
 */

export interface GateQuery {
  root: string
  fingerprint: string
}

export async function gate(deps: Deps, query: GateQuery): Promise<GateResponse> {
  const { db, config } = deps

  const approval = await db
    .selectFrom('approval')
    .selectAll()
    .where('root_path', '=', query.root)
    .where('fingerprint', '=', query.fingerprint)
    .executeTakeFirst()

  if (approval) {
    // Stamping records that a commit used this approval. It invalidates
    // nothing, so a commit that fails for an unrelated reason passes on the
    // next attempt; its only job is letting release tell used from unused.
    if (approval.consumed_at === null) {
      await db
        .updateTable('approval')
        .set({ consumed_at: now() })
        .where('id', '=', approval.id)
        .execute()
    }

    const openThreads = await openThreadsFor(db, approval.review_id)
    const warnings = await warningsFor(db, approval.review_id, query.root, openThreads.length)

    return {
      decision: 'allow',
      reason: `approved for ${query.root}`,
      reviewUrl: reviewUrl(config, approval.review_id),
      warnings,
      openThreads,
    }
  }

  return deny(deps, query)
}

async function deny(deps: Deps, query: GateQuery): Promise<GateResponse> {
  const { db, config } = deps

  const sources = await db
    .selectFrom('source')
    .selectAll()
    .where('root_path', '=', query.root)
    .execute()

  if (sources.length === 0) {
    return {
      decision: 'deny',
      reason: `Nobody has looked at ${query.root}. No review covers it.`,
      reviewUrl: null,
      warnings: [],
      openThreads: [],
    }
  }

  const reviewIds = [...new Set(sources.map((s) => s.review_id))]

  const stale = await db
    .selectFrom('approval')
    .selectAll()
    .where('root_path', '=', query.root)
    .orderBy('approved_at', 'desc')
    .executeTakeFirst()

  if (stale) {
    const snapshot = await db
      .selectFrom('snapshot')
      .select(['seq'])
      .where('id', '=', stale.snapshot_id)
      .executeTakeFirst()

    return {
      decision: 'deny',
      reason:
        `${query.root} was approved at snapshot ${snapshot?.seq ?? '?'}, ` +
        `and the tree has changed since. Take a new snapshot and review it.`,
      reviewUrl: reviewUrl(config, stale.review_id),
      warnings: [],
      openThreads: await openThreadsFor(db, stale.review_id),
    }
  }

  const reviewId = reviewIds[0] as string
  const openThreads = await openThreadsFor(db, reviewId)

  return {
    decision: 'deny',
    reason: `${query.root} has an open review that has not been approved.`,
    reviewUrl: reviewUrl(config, reviewId),
    warnings: [],
    openThreads,
  }
}

/**
 * Threads still owed an answer, reported on both allow and deny.
 *
 * On an allow these ride along as a warning rather than blocking, because
 * approving with threads open is a decision the reviewer is entitled to make.
 */
async function openThreadsFor(
  db: Kysely<Database>,
  reviewId: string,
): Promise<{ path: string; line: number; excerpt: string }[]> {
  const rows = await db
    .selectFrom('thread')
    .innerJoin('message', 'message.thread_id', 'thread.id')
    .select(['thread.id', 'thread.path', 'thread.line', 'message.body', 'message.seq'])
    .where('thread.review_id', '=', reviewId)
    .where('thread.state', '=', 'active')
    .where('message.submitted_at', 'is not', null)
    .orderBy('message.seq')
    .execute()

  const first = new Map<string, { path: string; line: number; excerpt: string }>()
  for (const row of rows) {
    if (first.has(row.id)) continue
    first.set(row.id, {
      path: row.path,
      line: row.line,
      excerpt: row.body.length > 120 ? `${row.body.slice(0, 117)}...` : row.body,
    })
  }

  return [...first.values()]
}

async function warningsFor(
  db: Kysely<Database>,
  reviewId: string,
  root: string,
  openThreadCount: number,
): Promise<string[]> {
  const warnings: string[] = []

  if (openThreadCount > 0) {
    warnings.push(
      `${openThreadCount} thread${openThreadCount === 1 ? '' : 's'} still open on this review`,
    )
  }

  // Another review covering the same root means a second session is working
  // here, which is worth saying out loud without blocking the commit.
  const others = await db
    .selectFrom('source')
    .select('review_id')
    .distinct()
    .where('root_path', '=', root)
    .where('review_id', '!=', reviewId)
    .execute()

  if (others.length > 0) {
    warnings.push(
      `${others.length} other review${others.length === 1 ? '' : 's'} also covers ${root}`,
    )
  }

  return warnings
}

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

/**
 * The agent acknowledging that it saw the outcome and needs none of the data.
 *
 * Releasing before the commit would delete the approval and block the very
 * commit that approval had cleared, so an unconsumed approval refuses unless
 * the caller says it is abandoning the review on purpose.
 */
export async function release(
  deps: Deps,
  reviewId: string,
  force: boolean,
): Promise<ReleaseResult> {
  const { db } = deps

  const review = await db
    .selectFrom('review')
    .selectAll()
    .where('id', '=', reviewId)
    .executeTakeFirst()

  if (!review) throw new ReviewError(`no review ${reviewId}`, 404)

  if (!force) {
    const unconsumed = await db
      .selectFrom('approval')
      .selectAll()
      .where('review_id', '=', reviewId)
      .where('consumed_at', 'is', null)
      .executeTakeFirst()

    if (unconsumed) {
      const minutes = Math.max(1, Math.round((now() - unconsumed.approved_at) / 60_000))
      return {
        released: false,
        reason:
          `Not released. ${unconsumed.root_path} was approved ${minutes} minute` +
          `${minutes === 1 ? '' : 's'} ago and no commit has used that approval yet. ` +
          `Commit first, or pass force to abandon it.`,
      }
    }
  }

  await db.deleteFrom('review').where('id', '=', reviewId).execute()
  await sweepOrphanBlobs(db)

  return { released: true }
}

/**
 * Collects blobs nothing references.
 *
 * Content-addressed rows outlive any one review on purpose, since another
 * review may hold the same bytes, so they are swept rather than cascaded.
 */
export async function sweepOrphanBlobs(db: Kysely<Database>): Promise<number> {
  const result = await db
    .deleteFrom('blob')
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('file_change')
            .select('file_change.id')
            .whereRef('file_change.new_blob_id', '=', 'blob.id'),
        ),
      ),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('file_change')
            .select('file_change.id')
            .whereRef('file_change.old_blob_id', '=', 'blob.id'),
        ),
      ),
    )
    .executeTakeFirst()

  return Number(result.numDeletedRows)
}
