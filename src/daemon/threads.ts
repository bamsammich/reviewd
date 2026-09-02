import { sql, type Kysely, type Transaction } from 'kysely'
import type {
  Author,
  CreateThreadRequest,
  SubmissionResult,
  Thread,
  ThreadState,
  Turn,
  Verdict,
} from '../protocol.js'
import { newId, now } from './db/ids.js'
import type { Database } from './db/types.js'
import { ReviewError, sha256, type Deps } from './reviews.js'

/**
 * Threads, messages, drafts, and submission.
 *
 * A thread carries two independent facts. Whether it is live is stored, since
 * only a person closes a conversation. Whose turn it is falls out of the last
 * submitted message, so no column can drift from the message list that holds
 * the truth.
 */

/** Lines either side of the anchor that re-anchoring compares against. */
const CONTEXT_RADIUS = 3

export interface ThreadFilter {
  state?: ThreadState
  turn?: Turn
  /**
   * Drafts are invisible to the agent by design. The UI passes true so the
   * reviewer sees the tray; every agent-facing path leaves it false.
   */
  includeDrafts?: boolean
}

// ---------------------------------------------------------------------------
// anchoring
// ---------------------------------------------------------------------------

export interface Anchor {
  anchorHash: string
  contextHash: string
  line: string
}

/** Hashes a line and its surroundings so a later snapshot can find it again. */
export function anchorFor(lines: string[], lineNumber: number): Anchor {
  const index = lineNumber - 1
  const anchor = lines[index] ?? ''

  const from = Math.max(0, index - CONTEXT_RADIUS)
  const to = Math.min(lines.length, index + CONTEXT_RADIUS + 1)
  const context = lines.slice(from, to).join('\n')

  return {
    anchorHash: sha256(Buffer.from(anchor, 'utf8')),
    contextHash: sha256(Buffer.from(context, 'utf8')),
    line: anchor,
  }
}

export function splitLines(bytes: Buffer): string[] {
  const text = bytes.toString('utf8')
  const lines = text.split('\n')
  // A trailing newline yields an empty last element that is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Reads the anchored line out of stored content.
 *
 * The daemon never opens the working tree, so this reads the blob the client
 * uploaded. A review therefore anchors against what was reviewed rather than
 * whatever the file says now.
 */
export async function readAnchor(
  db: Kysely<Database>,
  snapshotId: string,
  sourceId: string,
  path: string,
  side: 'old' | 'new',
  lineNumber: number,
  endLine?: number | undefined,
  /** The commit whose rows to read, or none for the combined change set. */
  commitId?: string | undefined,
): Promise<{ start: Anchor; end: Anchor | undefined; lineCount: number | undefined }> {
  const change = await db
    .selectFrom('file_change')
    .selectAll()
    .where('snapshot_id', '=', snapshotId)
    // The rows of the view the comment was left on. A line as one commit left
    // it is a different line from the same path in the combined change set,
    // and hashing the wrong one would anchor the comment to code the reader
    // was not looking at.
    .where((eb) =>
      commitId === undefined ? eb('commit_id', 'is', null) : eb('commit_id', '=', commitId),
    )
    .where('source_id', '=', sourceId)
    .where('path', '=', path)
    .executeTakeFirst()

  if (!change) {
    throw new ReviewError(`${path} is not in this snapshot`, 400)
  }

  const blobId = side === 'new' ? change.new_blob_id : change.old_blob_id
  if (!blobId) {
    // A deleted file has no new side, an added file has no old side.
    const empty = { anchorHash: sha256(Buffer.from('', 'utf8')), contextHash: '', line: '' }
    // No content to bound a line against, so the caller is not held to one.
    return { start: empty, end: endLine === undefined ? undefined : empty, lineCount: undefined }
  }

  const blob = await db.selectFrom('blob').selectAll().where('id', '=', blobId).executeTakeFirst()

  if (!blob) throw new ReviewError(`content for ${path} is missing`, 409)

  // One read for both ends, since a range is two lines of the same file.
  const lines = splitLines(Buffer.from(blob.bytes))

  return {
    start: anchorFor(lines, lineNumber),
    end: endLine === undefined ? undefined : anchorFor(lines, endLine),
    lineCount: lines.length,
  }
}

// ---------------------------------------------------------------------------
// create and reply
// ---------------------------------------------------------------------------

export async function createThread(
  deps: Deps,
  reviewId: string,
  request: CreateThreadRequest,
): Promise<{ threadId: string }> {
  const { db } = deps

  const snapshot = await latestSnapshot(db, reviewId)
  if (!snapshot) throw new ReviewError('review has no snapshot to comment on', 409)

  // A comment about the review as a whole is anchored to nothing, so every
  // column that describes a position stays null and there is no anchor to read.
  const unanchored = request.path === undefined || request.line === undefined

  if (unanchored) {
    return await insertThread(deps, reviewId, snapshot.id, request, {
      sourceId: null,
      path: null,
      side: null,
      line: null,
      endLine: null,
      anchorHash: null,
      contextHash: null,
      endAnchorHash: null,
      // A note about the change as a whole is about all of it, however the
      // reader happened to be reading when they wrote it.
      commitSha: null,
    })
  }

  const path = request.path as string
  const line = request.line as number

  // Resolved against this snapshot, so a comment cannot name a commit the
  // review does not carry. Refused rather than filed against the combined set:
  // a comment silently moved to a different reading of the code is worse than
  // one that did not save.
  const commit =
    request.commitSha === undefined ? undefined : await commitOf(db, snapshot.id, request.commitSha)

  if (request.commitSha !== undefined && commit === undefined) {
    throw new ReviewError(`this revision carries no commit ${request.commitSha}`, 400)
  }

  const sourceId = request.sourceId ?? (await onlySource(db, reviewId, path, commit?.id))

  // The wire schema refuses a backwards range, but that only runs on a parsed
  // request and this function is exported. Coercing it quietly would store a
  // one-line comment for a caller who asked for a block and say nothing.
  if (request.endLine !== undefined && request.endLine < line) {
    throw new ReviewError(
      `a comment cannot end on line ${request.endLine} and start on line ${line}`,
      400,
    )
  }

  // A range that ends on its own first line is one line, and storing it as a
  // range would mean two ways to say the same thing.
  const endLine =
    request.endLine !== undefined && request.endLine > line ? request.endLine : undefined

  const anchor = await readAnchor(
    db,
    snapshot.id,
    sourceId,
    path,
    request.side,
    line,
    endLine,
    commit?.id,
  )

  // A line past the end of the file hashes to the empty string, which matches
  // nothing later and would leave the comment marked drifted forever for a
  // reason that is really "this line was never there". Found by asking for a
  // range ending on line 280 of a 277-line file and getting no complaint.
  const last = endLine ?? line
  if (anchor.lineCount !== undefined && last > anchor.lineCount) {
    throw new ReviewError(
      `${path} has ${anchor.lineCount} lines on the ${request.side} side, so there is no line ${last}`,
      400,
    )
  }

  return await insertThread(deps, reviewId, snapshot.id, request, {
    sourceId,
    path,
    side: request.side,
    line,
    endLine: endLine ?? null,
    anchorHash: anchor.start.anchorHash,
    contextHash: anchor.start.contextHash,
    endAnchorHash: anchor.end?.anchorHash ?? null,
    commitSha: commit?.sha ?? null,
  })
}

/** Where a thread sits, with every field null for one about the review. */
interface ThreadPlace {
  sourceId: string | null
  path: string | null
  side: 'old' | 'new' | null
  line: number | null
  endLine: number | null
  anchorHash: string | null
  contextHash: string | null
  endAnchorHash: string | null
  /** The commit the comment was left on, or null for the combined change set. */
  commitSha: string | null
}

async function insertThread(
  deps: Deps,
  reviewId: string,
  snapshotId: string,
  request: CreateThreadRequest,
  place: ThreadPlace,
): Promise<{ threadId: string }> {
  const { db } = deps

  const threadId = newId()
  const t = now()

  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('thread')
      .values({
        id: threadId,
        review_id: reviewId,
        source_id: place.sourceId,
        path: place.path,
        side: place.side,
        line: place.line,
        end_line: place.endLine,
        anchor_hash: place.anchorHash,
        context_hash: place.contextHash,
        end_anchor_hash: place.endAnchorHash,
        commit_sha: place.commitSha,
        state: 'active',
        origin: request.author,
        drifted: 0,
        first_seen_snapshot: snapshotId,
        last_seen_snapshot: snapshotId,
        created_at: t,
        updated_at: t,
      })
      .execute()

    await appendMessage(tx, threadId, request.author, request.body, t)
    await tx
      .updateTable('review')
      .set({ last_activity_at: t, updated_at: t })
      .where('id', '=', reviewId)
      .execute()
  })

  // Only the agent's own writing is worth pushing. A reviewer's comment is
  // already on the page they wrote it from, and until they submit it, it is a
  // draft nobody else is meant to see.
  if (request.author === 'agent') {
    deps.bus?.publish({ kind: 'thread', reviewId, threadId, at: t })
  }

  return { threadId }
}

export async function replyToThread(
  deps: Deps,
  threadId: string,
  body: string,
  author: Author,
): Promise<{ threadId: string; turn: Turn }> {
  const { db } = deps

  const thread = await db
    .selectFrom('thread')
    .selectAll()
    .where('id', '=', threadId)
    .executeTakeFirst()

  if (!thread) throw new ReviewError(`no thread ${threadId}`, 404)

  const t = now()
  await db.transaction().execute(async (tx) => {
    await appendMessage(tx, threadId, author, body, t)
    await tx.updateTable('thread').set({ updated_at: t }).where('id', '=', threadId).execute()
    await tx
      .updateTable('review')
      .set({ last_activity_at: t, updated_at: t })
      .where('id', '=', thread.review_id)
      .execute()
  })

  if (author === 'agent') {
    deps.bus?.publish({ kind: 'thread', reviewId: thread.review_id, threadId, at: t })
  }

  return { threadId, turn: await turnOf(db, threadId) }
}

/**
 * Appends a message, drafting it when the reviewer wrote it.
 *
 * Agent messages submit on write, because the reviewer is looking at the thread
 * when one arrives and immediacy helps there. Reviewer messages wait for a
 * deliberate submit, so the agent never edits a file under a diff still being
 * read.
 *
 * The sequence is derived inside the insert rather than read first. Reading the
 * maximum and then inserting puts an await between the two, and what keeps two
 * replies to one thread from claiming the same number there is Kysely holding a
 * mutex over its single SQLite connection — a property of the driver rather
 * than of this code, and not one worth resting `message_thread_seq_unique` on.
 */
async function appendMessage(
  tx: Transaction<Database>,
  threadId: string,
  author: Author,
  body: string,
  t: number,
): Promise<string> {
  const id = newId()
  await tx
    .insertInto('message')
    .values({
      id,
      thread_id: threadId,
      seq: sql<number>`(select coalesce(max(seq), 0) + 1 from message where thread_id = ${threadId})`,
      author,
      body,
      created_at: t,
      submitted_at: author === 'agent' ? t : null,
      updated_at: t,
    })
    .execute()

  return id
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export async function setThreadState(
  deps: Deps,
  threadId: string,
  state: ThreadState,
  note?: string,
): Promise<{ threadId: string; state: ThreadState }> {
  const { db } = deps

  const thread = await db
    .selectFrom('thread')
    .selectAll()
    .where('id', '=', threadId)
    .executeTakeFirst()

  if (!thread) throw new ReviewError(`no thread ${threadId}`, 404)

  const t = now()
  await db.transaction().execute(async (tx) => {
    if (note) {
      await appendMessage(tx, threadId, 'agent', note, t)
    }
    await tx
      .updateTable('thread')
      .set({ state, updated_at: t })
      .where('id', '=', threadId)
      .execute()
  })

  return { threadId, state }
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export async function listThreads(
  deps: Deps,
  reviewId: string,
  filter: ThreadFilter = {},
): Promise<Thread[]> {
  const { db } = deps

  // Left, not inner. A thread about the review has no source, and an inner
  // join drops it from the list entirely rather than showing it unlabelled.
  let query = db
    .selectFrom('thread')
    .leftJoin('source', 'source.id', 'thread.source_id')
    .select([
      'thread.id',
      'thread.source_id',
      'thread.path',
      'thread.side',
      'thread.line',
      'thread.end_line',
      'thread.commit_sha',
      'thread.state',
      'thread.origin',
      'thread.drifted',
      'source.label as source_label',
    ])
    .where('thread.review_id', '=', reviewId)
    .orderBy('thread.created_at')

  if (filter.state) {
    query = query.where('thread.state', '=', filter.state)
  }

  const rows = await query.execute()
  if (rows.length === 0) return []

  const messages = await db
    .selectFrom('message')
    .selectAll()
    .where(
      'thread_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('seq')
    .execute()

  const byThread = new Map<string, typeof messages>()
  for (const message of messages) {
    const list = byThread.get(message.thread_id) ?? []
    list.push(message)
    byThread.set(message.thread_id, list)
  }

  const threads: Thread[] = []

  for (const row of rows) {
    const all = byThread.get(row.id) ?? []
    const visible = filter.includeDrafts ? all : all.filter((m) => m.submitted_at !== null)

    // A thread whose messages are all drafts has not reached the agent, so as
    // far as any agent-facing caller is concerned it does not exist.
    if (visible.length === 0) continue

    const turn = turnFrom(all)
    if (filter.turn && filter.turn !== turn) continue

    threads.push({
      id: row.id,
      sourceId: row.source_id,
      sourceLabel: row.source_label,
      path: row.path,
      side: row.side,
      line: row.line,
      endLine: row.end_line,
      commitSha: row.commit_sha,
      state: row.state,
      origin: row.origin,
      turn,
      drifted: row.drifted === 1,
      messages: visible.map((m) => ({
        id: m.id,
        seq: m.seq,
        author: m.author,
        body: m.body,
        createdAt: m.created_at,
        submittedAt: m.submitted_at,
      })),
    })
  }

  return threads
}

/**
 * Whose turn it is, from the last submitted message.
 *
 * A thread with nothing submitted is the reviewer's: it holds an unsent draft,
 * and the agent has no way to know it exists.
 */
export function turnFrom(messages: { author: Author; submitted_at: number | null }[]): Turn {
  const submitted = messages.filter((m) => m.submitted_at !== null)
  const last = submitted[submitted.length - 1]
  if (!last) return 'human'
  return last.author === 'human' ? 'agent' : 'human'
}

export async function turnOf(db: Kysely<Database>, threadId: string): Promise<Turn> {
  const messages = await db
    .selectFrom('message')
    .select(['author', 'submitted_at'])
    .where('thread_id', '=', threadId)
    .orderBy('seq')
    .execute()

  return turnFrom(messages)
}

// ---------------------------------------------------------------------------
// submission
// ---------------------------------------------------------------------------

/**
 * Sends every draft on the review at once and records the verdict.
 *
 * One transaction and one event, so `reviewd wait` fires once per submission
 * rather than once per comment. Approving writes an approval row per source,
 * which is the only thing the commit gate reads.
 */
export async function submitReview(
  deps: Deps,
  reviewId: string,
  verdict: Verdict,
  /**
   * Which commit an approval covers, or every commit when absent.
   *
   * The page sends whichever reading the reviewer had open, because approving
   * while looking at one commit is a claim about that commit and not about the
   * four they have not opened.
   */
  commitSha?: string | undefined,
): Promise<SubmissionResult> {
  const { db } = deps

  const review = await db
    .selectFrom('review')
    .selectAll()
    .where('id', '=', reviewId)
    .executeTakeFirst()

  if (!review) throw new ReviewError(`no review ${reviewId}`, 404)

  const snapshot = await latestSnapshot(db, reviewId)
  if (!snapshot) throw new ReviewError('review has no snapshot to submit against', 409)

  const submissionId = newId()
  const t = now()
  let messageCount = 0

  await db.transaction().execute(async (tx) => {
    const drafts = await tx
      .selectFrom('message')
      .innerJoin('thread', 'thread.id', 'message.thread_id')
      .select('message.id')
      .where('thread.review_id', '=', reviewId)
      .where('message.submitted_at', 'is', null)
      .execute()

    messageCount = drafts.length

    if (drafts.length > 0) {
      await tx
        .updateTable('message')
        .set({ submitted_at: t, updated_at: t })
        .where(
          'id',
          'in',
          drafts.map((d) => d.id),
        )
        .execute()
    }

    await tx
      .insertInto('submission')
      .values({
        id: submissionId,
        review_id: reviewId,
        verdict,
        message_count: messageCount,
        submitted_at: t,
      })
      .execute()

    if (verdict === 'approved') {
      await writeApprovals(tx, reviewId, snapshot.id, t, commitSha)
    } else {
      // The gate reads approvals, never review.status, so reopening the review
      // without clearing them would leave the agent free to commit code the
      // reviewer had just asked to change. Consumed rows stay: a commit
      // already used those, and that history is not ours to rewrite.
      await tx
        .deleteFrom('approval')
        .where('review_id', '=', reviewId)
        .where('consumed_at', 'is', null)
        .execute()

      // Per-commit coverage goes wholesale. Nothing records that a push used a
      // given commit's approval, so there is no consumed row to preserve, and
      // leaving them would let a stacked branch push commits the reviewer had
      // just asked to change.
      await tx.deleteFrom('approved_commit').where('review_id', '=', reviewId).execute()
    }

    // Approving one commit leaves the review open, because the reviewer has
    // not said the rest is good and the status is what a list of reviews reads
    // to say whether anything is still owed.
    await tx
      .updateTable('review')
      .set({
        status: verdict === 'approved' && commitSha === undefined ? 'approved' : 'open',
        last_activity_at: t,
        updated_at: t,
      })
      .where('id', '=', reviewId)
      .execute()
  })

  // One event per submission, never one per comment. This is what makes a
  // wait fire once when the reviewer presses Submit rather than four times
  // while they are still writing.
  deps.bus?.publish({ kind: 'submission', reviewId, verdict, at: t })

  return { submissionId, verdict, messageCount, submittedAt: t }
}

/**
 * One approval per source, carrying that source's own fingerprint.
 *
 * The gate matches on (root_path, fingerprint) rather than on a review id, so
 * an approval is a claim about a specific set of bytes and cannot let a review
 * of one repository authorize a commit in another.
 *
 * A commit named here narrows the whole thing to that commit. No fingerprint
 * approval is written, because a fingerprint covers the entire reading and the
 * reviewer has said nothing about the rest of it; the push gate still clears
 * once every commit has been covered one at a time.
 */
async function writeApprovals(
  tx: Transaction<Database>,
  reviewId: string,
  snapshotId: string,
  t: number,
  commitSha?: string | undefined,
): Promise<void> {
  const sources = await tx
    .selectFrom('snapshot_source')
    .innerJoin('source', 'source.id', 'snapshot_source.source_id')
    .select(['snapshot_source.source_id', 'snapshot_source.fingerprint', 'source.root_path'])
    .where('snapshot_source.snapshot_id', '=', snapshotId)
    .execute()

  if (sources.length === 0) return

  if (commitSha !== undefined) {
    return writeApprovedCommits(tx, reviewId, snapshotId, sources, t, commitSha)
  }

  await tx.deleteFrom('approval').where('review_id', '=', reviewId).execute()

  await tx
    .insertInto('approval')
    .values(
      sources.map((source) => ({
        id: newId(),
        review_id: reviewId,
        snapshot_id: snapshotId,
        source_id: source.source_id,
        root_path: source.root_path,
        fingerprint: source.fingerprint,
        approved_at: t,
        consumed_at: null,
      })),
    )
    .execute()

  await writeApprovedCommits(tx, reviewId, snapshotId, sources, t)
}

/**
 * Every commit the approved revision listed, recorded one row apiece.
 *
 * A fingerprint covers one range and expires the moment either end moves, so a
 * branch stacked on an open review sends its reviewer back through commits
 * they have already passed. Coverage per commit composes instead: the push
 * gate asks whether each commit leaving the machine was approved by anybody,
 * and the review below answers for its own.
 *
 * The rows outlive the snapshot that produced them and die with the review, so
 * releasing a review withdraws the approvals it granted.
 */
async function writeApprovedCommits(
  tx: Transaction<Database>,
  reviewId: string,
  snapshotId: string,
  sources: { source_id: string; root_path: string }[],
  t: number,
  /** One commit, or every commit the revision carries. */
  only?: string | undefined,
): Promise<void> {
  const roots = new Map(sources.map((source) => [source.source_id, source.root_path]))

  let query = tx
    .selectFrom('commit')
    .select(['source_id', 'sha', 'patch_id', 'parent_sha'])
    .where('snapshot_id', '=', snapshotId)

  if (only !== undefined) query = query.where('sha', '=', only)

  const commits = await query.execute()

  // Approving one commit adds to what is covered rather than replacing it,
  // which is the whole point of approving them one at a time. Approving the
  // change as a whole still starts over, because it is a statement about every
  // commit and a stale row would outlive the commit it described.
  if (only === undefined) {
    await tx.deleteFrom('approved_commit').where('review_id', '=', reviewId).execute()
  } else {
    await tx
      .deleteFrom('approved_commit')
      .where('review_id', '=', reviewId)
      .where('sha', '=', only)
      .execute()
  }

  // A review of a working tree lists no commits, and there is nothing here to
  // record. Its approval is the fingerprint, which is what commit gating asks
  // about anyway. A sha naming no commit in this revision lands here too.
  if (commits.length === 0) return

  await tx
    .insertInto('approved_commit')
    .values(
      commits.map((commit) => ({
        id: newId(),
        review_id: reviewId,
        root_path: roots.get(commit.source_id) ?? '',
        sha: commit.sha,
        patch_id: commit.patch_id,
        parent_sha: commit.parent_sha,
        approved_at: t,
      })),
    )
    .execute()
}

/** Removes an approval inside the window before a commit consumes it. */
export async function unapprove(
  deps: Deps,
  reviewId: string,
  /**
   * Which commit to take back, or the whole review when absent.
   *
   * Withdrawing follows the reading the reviewer had open, the way approving
   * does, so the two controls mean the same thing by "this commit".
   */
  commitSha?: string | undefined,
): Promise<{ removed: number }> {
  const { db } = deps
  const t = now()

  if (commitSha !== undefined) {
    const one = await db
      .deleteFrom('approved_commit')
      .where('review_id', '=', reviewId)
      .where('sha', '=', commitSha)
      .executeTakeFirst()

    // The fingerprint approval covers the whole reading, and one commit of it
    // is no longer approved, so it cannot stand. Taking it out is what stops a
    // push clearing on a range the reviewer has partly withdrawn.
    await db
      .deleteFrom('approval')
      .where('review_id', '=', reviewId)
      .where('consumed_at', 'is', null)
      .execute()

    await db
      .updateTable('review')
      .set({ status: 'open', last_activity_at: t, updated_at: t })
      .where('id', '=', reviewId)
      .execute()

    return { removed: Number(one.numDeletedRows) }
  }

  const result = await db
    .deleteFrom('approval')
    .where('review_id', '=', reviewId)
    .executeTakeFirst()

  await db.deleteFrom('approved_commit').where('review_id', '=', reviewId).execute()

  await db
    .updateTable('review')
    .set({ status: 'open', last_activity_at: t, updated_at: t })
    .where('id', '=', reviewId)
    .execute()

  return { removed: Number(result.numDeletedRows) }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function latestSnapshot(db: Kysely<Database>, reviewId: string) {
  return db
    .selectFrom('snapshot')
    .selectAll()
    .where('review_id', '=', reviewId)
    .orderBy('seq', 'desc')
    .executeTakeFirst()
}

/**
 * Resolves a path to its source when the caller named none.
 *
 * Two roots can hold the same relative path, so an ambiguous one is an error
 * rather than a guess: a comment filed against the wrong root is worse than a
 * comment refused.
 */
/** The commit of this snapshot with that sha, or none. */
async function commitOf(db: Kysely<Database>, snapshotId: string, sha: string) {
  return db
    .selectFrom('commit')
    .select(['id', 'sha'])
    .where('snapshot_id', '=', snapshotId)
    .where('sha', '=', sha)
    .executeTakeFirst()
}

async function onlySource(
  db: Kysely<Database>,
  reviewId: string,
  path: string,
  commitId?: string | undefined,
): Promise<string> {
  const snapshot = await latestSnapshot(db, reviewId)
  if (!snapshot) throw new ReviewError('review has no snapshot', 409)

  const matches = await db
    .selectFrom('file_change')
    .select('source_id')
    .distinct()
    .where('snapshot_id', '=', snapshot.id)
    // The rows of the view being commented on. A file one commit added and a
    // later one deleted is in no combined change set, so a comment naming it
    // without naming a commit is refused rather than filed against a path the
    // review does not show.
    .where((eb) =>
      commitId === undefined ? eb('commit_id', 'is', null) : eb('commit_id', '=', commitId),
    )
    .where('path', '=', path)
    .execute()

  const first = matches[0]
  if (!first) throw new ReviewError(`${path} is not in this review`, 400)
  if (matches.length > 1) {
    throw new ReviewError(`${path} appears in ${matches.length} roots; name one with sourceId`, 400)
  }

  return first.source_id
}

/**
 * Rewrites a comment the reviewer has not sent yet.
 *
 * Sent is the boundary and it is hard. Once a verdict carries a comment to the
 * agent, the agent has read it and may have acted on it, so changing the words
 * afterwards would leave it working from something the page no longer says.
 * An edited draft carries no trace of the edit, because nobody has seen the
 * version being replaced.
 *
 * The refusal after sending names the reason rather than reporting a missing
 * message, since a reviewer who reaches for it will otherwise read a 404 as a
 * broken button.
 */
export async function editDraft(deps: Deps, messageId: string, body: string): Promise<void> {
  const { db } = deps
  const message = await draftOr409(db, messageId, 'edited')

  const t = now()
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable('message')
      .set({ body, updated_at: t })
      .where('id', '=', messageId)
      .execute()
    await tx
      .updateTable('thread')
      .set({ updated_at: t })
      .where('id', '=', message.thread_id)
      .execute()
  })
}

/**
 * Drops a comment the reviewer has not sent yet.
 *
 * A thread whose last message goes with it is deleted too. A thread with no
 * messages is not something the page can draw: it would render as an empty box
 * anchored to a line, and the reviewer who deleted their only comment did not
 * mean to leave a marker behind.
 */
export async function deleteDraft(deps: Deps, messageId: string): Promise<void> {
  const { db } = deps
  const message = await draftOr409(db, messageId, 'deleted')

  const t = now()
  await db.transaction().execute(async (tx) => {
    await tx.deleteFrom('message').where('id', '=', messageId).execute()

    const left = await tx
      .selectFrom('message')
      .select('id')
      .where('thread_id', '=', message.thread_id)
      .executeTakeFirst()

    if (left) {
      await tx
        .updateTable('thread')
        .set({ updated_at: t })
        .where('id', '=', message.thread_id)
        .execute()
    } else {
      await tx.deleteFrom('thread').where('id', '=', message.thread_id).execute()
    }
  })
}

/** The message, if it is still a draft. Anything else is a 404 or a 409. */
async function draftOr409(
  db: Deps['db'],
  messageId: string,
  verb: 'edited' | 'deleted',
): Promise<{ thread_id: string }> {
  const message = await db
    .selectFrom('message')
    .select(['thread_id', 'submitted_at', 'author'])
    .where('id', '=', messageId)
    .executeTakeFirst()

  if (!message) throw new ReviewError(`no message ${messageId}`, 404)

  if (message.author !== 'human') {
    throw new ReviewError(`a comment from the agent cannot be ${verb}`, 409)
  }

  if (message.submitted_at !== null) {
    throw new ReviewError(
      `this comment has been sent, so it cannot be ${verb}. ` +
        `The agent has read it, and may have acted on it already.`,
      409,
    )
  }

  return message
}
