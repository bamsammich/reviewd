import type { Kysely } from 'kysely'
import type { GateResponse, ObserveResponse, ReleaseResult } from '../protocol.js'
import { approvalFollowsChange, gateScopeFor } from './config.js'
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

/**
 * How long an approval stays good.
 *
 * Long enough to cover a review read at breakfast and committed after lunch,
 * short enough that an approval is not a permanent key to a tree. A commit past
 * this gets the ordinary "take a new snapshot" denial, which is a reload of the
 * page rather than an obstacle.
 */
const APPROVAL_TTL_MS = 12 * 60 * 60 * 1000

export interface PushCommit {
  sha: string
  patchId?: string | null | undefined
  parentSha?: string | null | undefined
  subject?: string | undefined
}

export interface GateQuery {
  root: string
  fingerprint: string
  /** What this reading would commit, recorded so observe can compare. */
  tree?: string | null | undefined
  head?: string | null | undefined
  /** What a push carries, oldest first. Absent unless the question is a push. */
  commits?: PushCommit[] | undefined
}

export async function gate(deps: Deps, query: GateQuery): Promise<GateResponse> {
  const { db, config } = deps

  // Stamped here rather than at each return, because it describes the
  // repository and not the verdict: a denial has to carry it too, or the hook
  // learns which commands to hold only on the commits it was going to allow.
  const scope = gateScopeFor(config, query.root)

  const approval = await db
    .selectFrom('approval')
    .selectAll()
    .where('root_path', '=', query.root)
    .where('fingerprint', '=', query.fingerprint)
    // An approval is a decision someone made about code they had just read, and
    // it stops meaning that as the day goes on. Without a limit it is a token
    // that works forever for anyone who can reconstruct the tree it covered.
    .where('approved_at', '>', now() - APPROVAL_TTL_MS)
    .executeTakeFirst()

  if (approval) {
    // Stamping records that a commit used this approval. It invalidates
    // nothing, so a commit that fails for an unrelated reason passes on the
    // next attempt; its only job is letting release tell used from unused.
    if (approval.consumed_at === null) {
      // The tree and head ride along with the stamp, because they are only
      // true of the reading that matched. Recording them on a later call would
      // describe a different tree than the one this approval cleared.
      await db
        .updateTable('approval')
        .set({
          consumed_at: now(),
          gated_tree: query.tree ?? null,
          gated_head: query.head ?? null,
        })
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
      scope,
    }
  }

  // No approval covers this push as one range, which a stacked branch reaches
  // constantly: the commits underneath were read in their own review, and the
  // range moves the moment either branch gains a commit. Asking commit by
  // commit answers that without asking anybody to read the same code twice.
  if (query.commits !== undefined && query.commits.length > 0) {
    const verdict = await gateCommits(deps, query.root, query.commits)
    if (verdict !== null) return { ...verdict, scope }
  }

  return { ...(await deny(deps, query)), scope }
}

/**
 * Whether every commit a push carries was approved, one at a time.
 *
 * Null when nothing in this repository has ever been approved per commit,
 * which is a daemon holding approvals written before commits were the unit.
 * Falling through to the fingerprint leaves those working rather than denying
 * a reviewer's yes because the schema moved underneath it.
 *
 * A commit counts as approved when its sha was approved. Where
 * `gate.approval_follows` is `change`, which is the default, a matching patch
 * id counts too, and that is what carries an approval through a rebase, a
 * reword, or a cherry-pick onto another branch. The patch id is a weaker claim
 * on purpose: it says somebody read this change, not that they read it sitting
 * where it sits now. Where the two disagree the response says so, because a
 * commit that moved is worth a reader knowing about and is not worth refusing
 * a push over.
 *
 * Setting `gate.approval_follows` to `commit` takes that away, for a
 * repository where a review is about a state rather than a change: every
 * rewrite then costs a fresh approval.
 */
async function gateCommits(
  deps: Deps,
  root: string,
  commits: PushCommit[],
): Promise<Omit<GateResponse, 'scope'> | null> {
  const { db, config } = deps

  const approved = await db
    .selectFrom('approved_commit')
    .selectAll()
    .where('root_path', '=', root)
    .where('approved_at', '>', now() - APPROVAL_TTL_MS)
    .execute()

  if (approved.length === 0) return null

  const bySha = new Map(approved.map((row) => [row.sha, row]))

  // Empty where the repository attaches an approval to the commit rather than
  // to what it does, which leaves every commit answerable by sha alone.
  const byPatch = approvalFollowsChange(config)
    ? new Map(
        approved.filter((row) => row.patch_id !== null).map((row) => [row.patch_id as string, row]),
      )
    : new Map<string, (typeof approved)[number]>()

  const missing: PushCommit[] = []
  const moved: string[] = []
  const covering: string[] = []

  for (const commit of commits) {
    const exact = bySha.get(commit.sha)
    const rebased = commit.patchId != null ? byPatch.get(commit.patchId) : undefined
    const row = exact ?? rebased

    if (row === undefined) {
      missing.push(commit)
      continue
    }

    covering.push(row.review_id)

    // Approved under a different sha, so the branch was rewritten after it was
    // read. The change is the one that was approved; where it sits is not.
    if (exact === undefined) moved.push(commit.sha.slice(0, 12))
  }

  const reviewId = covering[0]
  const url = reviewId !== undefined ? reviewUrl(config, reviewId) : null

  if (missing.length > 0) {
    return {
      decision: 'deny',
      reason: denialForCommits(root, missing, commits.length),
      reviewUrl: url,
      warnings: [],
      openThreads: [],
    }
  }

  const openThreads = reviewId !== undefined ? await openThreadsFor(db, reviewId) : []

  const warnings =
    moved.length === 0
      ? []
      : [
          `${moved.length === 1 ? 'Commit' : 'Commits'} ${moved.join(', ')} ${
            moved.length === 1 ? 'carries' : 'carry'
          } an approved change under a sha nobody approved, which a rebase, a ` +
            `reword or a cherry-pick all leave behind. The change was read; where ` +
            `it now sits was not.`,
        ]

  return {
    decision: 'allow',
    reason: `every commit this push carries in ${root} was approved`,
    reviewUrl: url,
    warnings,
    openThreads,
  }
}

/** Named, because a reader cannot act on a count. */
const COMMITS_NAMED = 5

function denialForCommits(root: string, missing: PushCommit[], total: number): string {
  const named = missing
    .slice(0, COMMITS_NAMED)
    .map((commit) => {
      const subject = commit.subject !== undefined && commit.subject.length > 0
      return `  ${commit.sha.slice(0, 12)}${subject ? ` ${commit.subject}` : ''}`
    })
    .join('\n')

  const rest = missing.length - Math.min(missing.length, COMMITS_NAMED)
  const more = rest > 0 ? `\n  and ${rest} more` : ''

  return (
    `This push carries ${total} ${total === 1 ? 'commit' : 'commits'} in ${root}, and ` +
    `${missing.length} of them ${missing.length === 1 ? 'has' : 'have'} no approval:\n` +
    `${named}${more}\n` +
    `Open a review that reaches back far enough to include ${
      missing.length === 1 ? 'it' : 'them'
    }, or push the branch below this one first so its commits stop being part of this push.`
  )
}

export interface ObserveQuery {
  root: string
  head: string
  tree: string
}

/**
 * What a commit turned out to be, asked after it happened.
 *
 * The gate runs before the command and reads the tree as it stands then, so a
 * command that edits files and commits in one line is cleared on bytes that
 * are not the bytes it records. Nothing before the fact can see that, and
 * nothing at all sees a commit reached through a wrapper the hook does not
 * recognise. Both are visible afterwards, from the commit itself.
 *
 * Detection, not prevention. The commit already exists; saying so is the whole
 * job, because the failure today is that it passes unnoticed.
 */
export async function observe(deps: Deps, query: ObserveQuery): Promise<ObserveResponse> {
  const { db, config } = deps

  const sources = await db
    .selectFrom('source')
    .select(['review_id'])
    .where('root_path', '=', query.root)
    .execute()

  // A repository nobody is reviewing is not this function's business.
  if (sources.length === 0) {
    return { finding: 'clean', reason: `no review covers ${query.root}`, reviewUrl: null }
  }

  const approval = await db
    .selectFrom('approval')
    .selectAll()
    .where('root_path', '=', query.root)
    .where('consumed_at', 'is not', null)
    .orderBy('consumed_at', 'desc')
    .executeTakeFirst()

  const url = (reviewId: string): string => reviewUrl(config, reviewId)

  if (!approval) {
    return {
      finding: 'ungated',
      reason:
        `${query.head.slice(0, 12)} is committed in ${query.root}, and no approval was used ` +
        `to make it. The gate never saw the commit, so nothing checked it against a review.`,
      reviewUrl: url(sources[0]?.review_id ?? ''),
    }
  }

  // An approval written before this was recorded cannot answer, and saying
  // "clean" on a question that was never asked is the failure being fixed.
  if (approval.gated_tree === null) {
    return {
      finding: 'unknown',
      reason:
        `${query.root} was approved, but that approval predates recording what it cleared, ` +
        `so what ${query.head.slice(0, 12)} carries cannot be compared to it.`,
      reviewUrl: url(approval.review_id),
    }
  }

  if (approval.gated_tree === query.tree) {
    return {
      finding: 'clean',
      reason: `${query.head.slice(0, 12)} carries what was approved`,
      reviewUrl: url(approval.review_id),
    }
  }

  // The head the gate saw is the parent the commit was built on. Matching it
  // says this is that commit, and its tree still disagrees, which is the
  // edit-then-commit case rather than an unrelated commit turning up.
  const sameLine = approval.gated_head !== null

  return {
    finding: sameLine ? 'altered' : 'ungated',
    reason: sameLine
      ? `${query.head.slice(0, 12)} records tree ${query.tree.slice(0, 12)}, and the approval ` +
        `for ${query.root} cleared tree ${approval.gated_tree.slice(0, 12)}. The working tree ` +
        `changed between the approval and the commit, so the commit carries code no review showed.`
      : `${query.head.slice(0, 12)} in ${query.root} carries a tree no approval cleared.`,
    reviewUrl: url(approval.review_id),
  }
}

async function deny(deps: Deps, query: GateQuery): Promise<Omit<GateResponse, 'scope'>> {
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
    // A comment on the review as a whole has no line to point the reader at.
    // It still counts as an open thread; it just cannot be listed by position.
    if (row.path === null || row.line === null) continue
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

  // Binary and oversize content is described rather than rendered, so the
  // reviewer approved a row saying "binary" and not the bytes behind it. The
  // fingerprint covers them, so this is not a hole; it is worth saying out loud
  // because "approved" and "read" came apart for those files.
  // Scoped to the revision being approved. Counting every revision the review
  // ever held reported fourteen unread files where there was one, which is the
  // kind of number that teaches a reviewer to stop reading the warning.
  const latest = await db
    .selectFrom('snapshot')
    .select('id')
    .where('review_id', '=', reviewId)
    .orderBy('seq', 'desc')
    .executeTakeFirst()

  const unread = latest
    ? await db
        .selectFrom('file_change')
        .select(({ fn }) => fn.countAll<number>().as('n'))
        .where('snapshot_id', '=', latest.id)
        // The combined change set, so a binary file the push touched five
        // times is one file nobody could read rather than five.
        .where('commit_id', 'is', null)
        .where((eb) =>
          eb.or([eb('file_change.is_binary', '=', 1), eb('file_change.truncated', '=', 1)]),
        )
        .executeTakeFirst()
    : undefined

  if (unread && unread.n > 0) {
    warnings.push(
      `${unread.n} file${unread.n === 1 ? '' : 's'} could not be shown in the diff ` +
        `(binary or too large) and were approved unread`,
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

  // A session parked on this review learns the data is gone rather than
  // waiting out its timeout against something that no longer exists.
  deps.bus?.publish({ kind: 'released', reviewId, at: now() })

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
