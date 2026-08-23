import type { Kysely, Transaction } from 'kysely'
import type {
  Author,
  CreateThreadRequest,
  SubmissionResult,
  Thread,
  ThreadState,
  Turn,
  Verdict,
} from '@reviewd/protocol'
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
): Promise<Anchor> {
  const change = await db
    .selectFrom('file_change')
    .selectAll()
    .where('snapshot_id', '=', snapshotId)
    .where('source_id', '=', sourceId)
    .where('path', '=', path)
    .executeTakeFirst()

  if (!change) {
    throw new ReviewError(`${path} is not in this snapshot`, 400)
  }

  const blobId = side === 'new' ? change.new_blob_id : change.old_blob_id
  if (!blobId) {
    // A deleted file has no new side, an added file has no old side.
    return { anchorHash: sha256(Buffer.from('', 'utf8')), contextHash: '', line: '' }
  }

  const blob = await db.selectFrom('blob').selectAll().where('id', '=', blobId).executeTakeFirst()

  if (!blob) throw new ReviewError(`content for ${path} is missing`, 409)

  return anchorFor(splitLines(Buffer.from(blob.bytes)), lineNumber)
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

  const sourceId = request.sourceId ?? (await onlySource(db, reviewId, request.path))
  const anchor = await readAnchor(
    db,
    snapshot.id,
    sourceId,
    request.path,
    request.side,
    request.line,
  )

  const threadId = newId()
  const t = now()

  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('thread')
      .values({
        id: threadId,
        review_id: reviewId,
        source_id: sourceId,
        path: request.path,
        side: request.side,
        line: request.line,
        anchor_hash: anchor.anchorHash,
        context_hash: anchor.contextHash,
        state: 'active',
        origin: request.author,
        drifted: 0,
        first_seen_snapshot: snapshot.id,
        last_seen_snapshot: snapshot.id,
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
 */
async function appendMessage(
  tx: Transaction<Database>,
  threadId: string,
  author: Author,
  body: string,
  t: number,
): Promise<string> {
  const last = await tx
    .selectFrom('message')
    .select('seq')
    .where('thread_id', '=', threadId)
    .orderBy('seq', 'desc')
    .executeTakeFirst()

  const id = newId()
  await tx
    .insertInto('message')
    .values({
      id,
      thread_id: threadId,
      seq: (last?.seq ?? 0) + 1,
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

  let query = db
    .selectFrom('thread')
    .innerJoin('source', 'source.id', 'thread.source_id')
    .select([
      'thread.id',
      'thread.source_id',
      'thread.path',
      'thread.side',
      'thread.line',
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
      anchorLine: '',
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
 * One transaction and one event, so `reviewctl wait` fires once per submission
 * rather than once per comment. Approving writes an approval row per source,
 * which is the only thing the commit gate reads.
 */
export async function submitReview(
  deps: Deps,
  reviewId: string,
  verdict: Verdict,
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
      await writeApprovals(tx, reviewId, snapshot.id, t)
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
    }

    await tx
      .updateTable('review')
      .set({
        status: verdict === 'approved' ? 'approved' : 'open',
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
 */
async function writeApprovals(
  tx: Transaction<Database>,
  reviewId: string,
  snapshotId: string,
  t: number,
): Promise<void> {
  const sources = await tx
    .selectFrom('snapshot_source')
    .innerJoin('source', 'source.id', 'snapshot_source.source_id')
    .select(['snapshot_source.source_id', 'snapshot_source.fingerprint', 'source.root_path'])
    .where('snapshot_source.snapshot_id', '=', snapshotId)
    .execute()

  await tx.deleteFrom('approval').where('review_id', '=', reviewId).execute()

  if (sources.length === 0) return

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
}

/** Removes an approval inside the window before a commit consumes it. */
export async function unapprove(deps: Deps, reviewId: string): Promise<{ removed: number }> {
  const { db } = deps
  const t = now()

  const result = await db
    .deleteFrom('approval')
    .where('review_id', '=', reviewId)
    .executeTakeFirst()

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
async function onlySource(db: Kysely<Database>, reviewId: string, path: string): Promise<string> {
  const snapshot = await latestSnapshot(db, reviewId)
  if (!snapshot) throw new ReviewError('review has no snapshot', 409)

  const matches = await db
    .selectFrom('file_change')
    .select('source_id')
    .distinct()
    .where('snapshot_id', '=', snapshot.id)
    .where('path', '=', path)
    .execute()

  const first = matches[0]
  if (!first) throw new ReviewError(`${path} is not in this review`, 400)
  if (matches.length > 1) {
    throw new ReviewError(`${path} appears in ${matches.length} roots; name one with sourceId`, 400)
  }

  return first.source_id
}
