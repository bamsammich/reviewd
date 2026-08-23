import type { Kysely } from 'kysely'
import { now } from './db/ids.js'
import type { Database } from './db/types.js'
import { sweepOrphanBlobs } from './gate.js'
import type { Deps } from './reviews.js'

/**
 * Deletion the daemon performs on its own.
 *
 * Only leaks, never policy. A review whose session died is a leak rather than a
 * record, but the daemon cannot tell that apart from a reviewer who stepped
 * away for an evening, so the horizon is long and keyed on activity rather than
 * on age. The normal end of a review is the agent releasing it.
 */

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

export interface SweepResult {
  reviews: number
  blobs: number
  removed: { id: string; title: string; idleDays: number }[]
}

export async function runSweep(deps: Deps): Promise<SweepResult> {
  const { db, config } = deps
  const cutoff = now() - config.sweep.review_idle_days * DAY_MS

  const stale = await db
    .selectFrom('review')
    .select(['id', 'title', 'last_activity_at'])
    .where('last_activity_at', '<', cutoff)
    .execute()

  for (const review of stale) {
    await db.deleteFrom('review').where('id', '=', review.id).execute()
  }

  const blobs = await sweepOrphanBlobs(db)

  return {
    reviews: stale.length,
    blobs,
    removed: stale.map((review) => ({
      id: review.id,
      title: review.title,
      idleDays: Math.floor((now() - review.last_activity_at) / DAY_MS),
    })),
  }
}

/**
 * Runs at startup and hourly, logging what it removed.
 *
 * Discovering the sweep by noticing an absence is the failure mode worth
 * avoiding, so every deletion says so out loud.
 */
export function scheduleSweep(
  deps: Deps,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): () => void {
  const sweep = async (): Promise<void> => {
    try {
      const result = await runSweep(deps)
      for (const review of result.removed) {
        log(`reviewd swept "${review.title}" after ${review.idleDays} idle days`)
      }
      if (result.blobs > 0) {
        log(`reviewd collected ${result.blobs} unreferenced blob(s)`)
      }
    } catch (error) {
      log(`reviewd sweep failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  void sweep()
  const timer = setInterval(() => void sweep(), HOUR_MS)
  timer.unref?.()

  return () => clearInterval(timer)
}

/** Marks a review as looked at, which is what keeps the sweep off it. */
export async function touchReview(db: Kysely<Database>, reviewId: string): Promise<void> {
  const t = now()
  await db.updateTable('review').set({ last_activity_at: t }).where('id', '=', reviewId).execute()
}
