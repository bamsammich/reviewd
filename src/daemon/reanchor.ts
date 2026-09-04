import type { Kysely } from 'kysely'
import { now } from './db/ids.js'
import type { Database } from './db/types.js'
import { anchorFor, splitLines } from './threads.js'

/**
 * Moving threads onto the code they were written against.
 *
 * A comment anchored to line 42 of a file that gained ten lines above it
 * belongs on line 52, not on whatever line 42 says now. The line's own hash
 * finds it; the surrounding hash says whether the neighbourhood it was written
 * about survived.
 */

export interface ReanchorResult {
  moved: number
  outdated: number
}

/** A thread as read, which may belong to the review rather than to a line. */
type ThreadCandidate = {
  [K in keyof ThreadRow]: K extends 'end_line' | 'end_anchor_hash'
    ? ThreadRow[K]
    : ThreadRow[K] | null
}

/**
 * Whether this thread is about a line at all.
 *
 * A comment on the review as a whole has nothing to re-anchor and cannot go
 * outdated, because it was never about code that could move.
 */
function isAnchored(thread: ThreadCandidate): thread is ThreadRow {
  return (
    thread.source_id !== null &&
    thread.path !== null &&
    thread.side !== null &&
    thread.line !== null &&
    thread.anchor_hash !== null &&
    thread.context_hash !== null
  )
}

interface ThreadRow {
  id: string
  source_id: string
  path: string
  side: 'old' | 'new'
  line: number
  end_line: number | null
  anchor_hash: string
  context_hash: string
  end_anchor_hash: string | null
  /** Null for a comment on the whole push; a sha for one left on a commit. */
  commit_sha: string | null
}

export async function reanchor(
  db: Kysely<Database>,
  reviewId: string,
  snapshotId: string,
): Promise<ReanchorResult> {
  const threads = await db
    .selectFrom('thread')
    .select([
      'id',
      'source_id',
      'path',
      'side',
      'line',
      'end_line',
      'anchor_hash',
      'context_hash',
      'end_anchor_hash',
      'commit_sha',
    ])
    .where('review_id', '=', reviewId)
    .where('state', '!=', 'resolved')
    .execute()

  if (threads.length === 0) return { moved: 0, outdated: 0 }

  const t = now()
  let moved = 0
  let outdated = 0

  // One read per file rather than per thread, since several comments on one
  // file is the normal case.
  const lineCache = new Map<string, string[] | null>()

  for (const thread of threads.filter(isAnchored)) {
    const found_ = await linesFor(db, reviewId, snapshotId, thread, lineCache)

    if (!found_) {
      await markOutdated(db, thread.id, snapshotId, t)
      outdated += 1
      continue
    }

    const { lines, sha } = found_
    const found = locate(lines, thread)

    if (!found) {
      await markOutdated(db, thread.id, snapshotId, t)
      outdated += 1
      continue
    }

    const changedLine = found.line !== thread.line
    if (changedLine) moved += 1

    const range = locateEnd(lines, thread, found.line)

    // The sha travels with the comment when the commit was rewritten. The page
    // draws a thread on the commit whose sha it holds, so a comment that
    // followed its change and kept the old sha would re-anchor correctly and
    // then render on no commit at all.
    await db
      .updateTable('thread')
      .set({
        line: found.line,
        end_line: range.endLine,
        context_hash: found.contextHash,
        drifted: found.drifted || range.drifted ? 1 : 0,
        state: 'active',
        last_seen_snapshot: snapshotId,
        updated_at: t,
        ...(sha === null ? {} : { commit_sha: sha }),
      })
      .where('id', '=', thread.id)
      .execute()
  }

  return { moved, outdated }
}

/**
 * Finds the anchored line in the new content.
 *
 * The old line number is tried first, because a file that did not move is the
 * common case and scanning it would be waste. Only then does the whole file get
 * searched for the same line elsewhere.
 */
export function locate(
  lines: string[],
  thread: { line: number; anchor_hash: string; context_hash: string },
): { line: number; contextHash: string; drifted: boolean } | undefined {
  const atOriginal = anchorFor(lines, thread.line)
  if (atOriginal.anchorHash === thread.anchor_hash) {
    return {
      line: thread.line,
      contextHash: atOriginal.contextHash,
      drifted: atOriginal.contextHash !== thread.context_hash,
    }
  }

  // The line moved, so look for it elsewhere. A context match settles which
  // copy is the right one when the same line appears more than once.
  let weak: { line: number; contextHash: string } | undefined

  for (let i = 1; i <= lines.length; i += 1) {
    if (i === thread.line) continue

    const candidate = anchorFor(lines, i)
    if (candidate.anchorHash !== thread.anchor_hash) continue

    if (candidate.contextHash === thread.context_hash) {
      return { line: i, contextHash: candidate.contextHash, drifted: false }
    }

    weak ??= { line: i, contextHash: candidate.contextHash }
  }

  // The line survives but its surroundings changed, so the comment moves and
  // the UI says the code around it is not what it was written about.
  return weak ? { line: weak.line, contextHash: weak.contextHash, drifted: true } : undefined
}

/**
 * Carries a range's end along with its start.
 *
 * The start is found by hashing the line and looking for that hash, which is
 * what survives edits above. The end cannot be found the same way: a range's
 * last line is often something unremarkable like a closing brace, and searching
 * for it would land on the wrong one. So the length comes along and the end is
 * placed by arithmetic, then checked.
 *
 * Checked against the hash stored when the comment was written, which is what
 * separates "the range is intact" from "something inside it changed". A range
 * whose end no longer matches stays anchored and is marked drifted: the reader
 * is told the code moved under the comment rather than losing it.
 */
export function locateEnd(
  lines: string[],
  thread: { line: number; end_line: number | null; end_anchor_hash: string | null },
  startLine: number,
): { endLine: number | null; drifted: boolean } {
  if (thread.end_line === null) return { endLine: null, drifted: false }

  const length = thread.end_line - thread.line
  const end = startLine + length

  // The range now runs off the end of the file, so it covers what is left.
  if (end > lines.length) {
    return { endLine: Math.max(startLine, lines.length), drifted: true }
  }

  const intact = anchorFor(lines, end).anchorHash === thread.end_anchor_hash
  return { endLine: end, drifted: !intact }
}

/**
 * Which commit of the new revision a thread belongs to, or null for a thread
 * about the change as a whole.
 *
 * The sha answers first, and stops answering the moment anybody rebases:
 * a rewrite gives every commit it touches a new sha and leaves the change
 * alone. Reading only the sha meant a comment left on a commit outdated on
 * every amend, rebase and cherry-pick, which is most of what revising a stack
 * consists of, so commenting on a commit was worth much less than it looked.
 *
 * `git patch-id --stable` says what a commit does rather than where it sits,
 * and an earlier revision's rows still hold the one the comment was written
 * against. So a sha that no longer exists is looked up by what it did, and the
 * comment follows the change.
 *
 * Null when nothing in the new revision does what that commit did, which is
 * what a squash produces and is a commit genuinely gone.
 */
async function commitOf(
  db: Kysely<Database>,
  reviewId: string,
  snapshotId: string,
  sha: string,
): Promise<{ id: string; sha: string } | null> {
  const exact = await db
    .selectFrom('commit')
    .select(['id', 'sha'])
    .where('snapshot_id', '=', snapshotId)
    .where('sha', '=', sha)
    .executeTakeFirst()

  if (exact) return exact

  // What the commit did, read from whichever revision still carries it.
  const was = await db
    .selectFrom('commit')
    .innerJoin('snapshot', 'snapshot.id', 'commit.snapshot_id')
    .select('commit.patch_id as patchId')
    .where('snapshot.review_id', '=', reviewId)
    .where('commit.sha', '=', sha)
    .where('commit.patch_id', 'is not', null)
    .executeTakeFirst()

  if (!was?.patchId) return null

  const moved = await db
    .selectFrom('commit')
    .select(['id', 'sha'])
    .where('snapshot_id', '=', snapshotId)
    .where('patch_id', '=', was.patchId)
    .executeTakeFirst()

  return moved ?? null
}

/**
 * The lines a thread should be measured against in the new revision.
 *
 * A comment on the whole push reads the combined change set. A comment left on
 * one commit reads that commit's rows: a commit holds the same path with the
 * blobs that commit saw, and measuring one against the other would move a
 * comment onto a state the reviewer was never shown.
 *
 * Nothing is forced to drift when a commit was rewritten. Drift is a claim
 * about the code around a line, and the ordinary comparison still makes it
 * against the moved commit's own content: a patch that survived a rebase
 * unchanged finds its line with matching context and does not drift, and one
 * whose surroundings changed drifts because they did.
 */
async function linesFor(
  db: Kysely<Database>,
  reviewId: string,
  snapshotId: string,
  thread: ThreadRow,
  cache: Map<string, string[] | null>,
): Promise<{ lines: string[]; sha: string | null } | null> {
  const key = `${thread.commit_sha ?? ''}:${thread.source_id}:${thread.path}:${thread.side}`
  const cached = cache.get(key)

  let commitId: string | undefined
  let sha: string | null = null

  if (thread.commit_sha !== null) {
    const commit = await commitOf(db, reviewId, snapshotId, thread.commit_sha)

    if (!commit) {
      cache.set(key, null)
      return null
    }

    commitId = commit.id
    sha = commit.sha === thread.commit_sha ? null : commit.sha
  }

  if (cached !== undefined) return cached === null ? null : { lines: cached, sha }

  const change = await db
    .selectFrom('file_change')
    .selectAll()
    .where('snapshot_id', '=', snapshotId)
    .where((eb) =>
      commitId === undefined ? eb('commit_id', 'is', null) : eb('commit_id', '=', commitId),
    )
    .where('source_id', '=', thread.source_id)
    .where('path', '=', thread.path)
    .executeTakeFirst()

  const blobId = change ? (thread.side === 'new' ? change.new_blob_id : change.old_blob_id) : null

  if (!blobId) {
    // The file left the change set, or lost the side this thread was on.
    cache.set(key, null)
    return null
  }

  const blob = await db.selectFrom('blob').selectAll().where('id', '=', blobId).executeTakeFirst()
  const lines = blob ? splitLines(Buffer.from(blob.bytes)) : null

  cache.set(key, lines)
  return lines === null ? null : { lines, sha }
}

async function markOutdated(
  db: Kysely<Database>,
  threadId: string,
  snapshotId: string,
  t: number,
): Promise<void> {
  await db
    .updateTable('thread')
    .set({ state: 'outdated', last_seen_snapshot: snapshotId, updated_at: t })
    .where('id', '=', threadId)
    .execute()
}
