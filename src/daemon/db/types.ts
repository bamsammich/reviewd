import type { ColumnType } from 'kysely'

/**
 * Row shapes for the SQLite schema.
 *
 * Conventions, most of which are SQLite facts rather than choices:
 *   - primary keys are TEXT holding a UUIDv7, sortable by creation time
 *   - timestamps are INTEGER epoch milliseconds, because SQLite has no date type
 *   - booleans are INTEGER 0/1, because SQLite has no boolean type
 *   - enums are TEXT with a CHECK constraint, because SQLite has no enum type
 */

/** Epoch milliseconds. */
type Millis = number

/** 0 or 1. SQLite has no boolean. */
type Bool = 0 | 1

export interface ReviewTable {
  id: string
  title: string
  status: 'open' | 'approved'
  created_by: string
  created_at: Millis
  last_activity_at: Millis
  updated_at: Millis
}

export interface SourceTable {
  id: string
  review_id: string
  label: string
  root_path: string
  vcs: 'git' | 'none'
  base_ref: string | null
  ordinal: number
  /**
   * Whether approving this source can clear a commit gate on it.
   *
   * Null on a row written before the client sent it, which reads as yes: every
   * such row was a repository root or a directory outside one, and neither
   * carried this trap.
   */
  can_gate: number | null
}

export interface SnapshotTable {
  id: string
  review_id: string
  seq: number
  fingerprint: string
  created_at: Millis
}

/**
 * One commit of a push, as much of it as the daemon can be told.
 *
 * The daemon never runs git and cannot see the repository, so everything here
 * arrives computed by the client. Ordered oldest first, which is the order the
 * commits were written in rather than the order rev-list hands them back.
 */
export interface CommitTable {
  id: string
  snapshot_id: string
  source_id: string
  sha: string
  subject: string
  author: string
  committed_at: Millis
  ordinal: number
  /**
   * `git patch-id --stable`, and the commit this one sat on when it was read.
   *
   * Both are null for a revision uploaded by a client too old to compute them,
   * which the gate reads as a commit it can only recognise by sha.
   */
  patch_id: string | null
  parent_sha: string | null
}

export interface FileChangeTable {
  id: string
  snapshot_id: string
  source_id: string
  /**
   * The commit this change belongs to, or null for the combined change set.
   *
   * Both live in this table at once: the rows with no commit are the sum of
   * the push, which is what the page has always drawn, and the rows with one
   * are what a single commit did. A review from before commits were stored has
   * only the first kind and renders unchanged.
   */
  commit_id: string | null
  path: string
  change_type: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary'
  old_path: string | null
  old_blob_id: string | null
  new_blob_id: string | null
  is_binary: Bool
  truncated: Bool
}

/**
 * A snapshot covers every source at once, and each source carries its own
 * fingerprint, because the gate asks about one repository at a time.
 */
export interface SnapshotSourceTable {
  snapshot_id: string
  source_id: string
  fingerprint: string
}

export interface BlobTable {
  /** sha256 of the content. Content-addressed, so it dedupes across snapshots. */
  id: string
  bytes: ColumnType<Buffer, Buffer | Uint8Array, never>
  size: number
}

export interface ThreadTable {
  id: string
  review_id: string
  /**
   * All null together, for a comment about the review rather than about a line.
   *
   * Feedback on the approach, the naming, or the shape of a change belongs to
   * no line, and anchoring it to one is worse than leaving it loose: the next
   * snapshot re-anchors or outdates a comment that was never about that code.
   * Re-anchoring skips these, since there is nothing to re-anchor.
   */
  source_id: string | null
  path: string | null
  side: 'old' | 'new' | null
  line: number | null
  anchor_hash: string | null
  context_hash: string | null
  /**
   * The last line a range covers, or null for a comment on one line.
   *
   * Null rather than a copy of `line`, so that "is this a range" is a question
   * about the data rather than a comparison, and so that every thread written
   * before ranges existed keeps its original meaning.
   */
  end_line: number | null
  /** Hash of the last line, which is how re-anchoring tells a range survived. */
  end_anchor_hash: string | null
  /**
   * Whether the conversation is live. Whose turn it is stays derived from the
   * last message, so no column here can drift away from the message list.
   */
  /**
   * The commit this comment was left on, or null for the combined change set.
   *
   * A sha rather than a reference to a commit row, because commit rows belong
   * to one snapshot and are replaced by the next, while a comment outlives the
   * revision it was written against.
   */
  commit_sha: string | null
  state: 'active' | 'resolved' | 'outdated'
  origin: 'human' | 'agent'
  /** Set when re-anchoring matched the line but not its surroundings. */
  drifted: Bool
  first_seen_snapshot: string
  last_seen_snapshot: string
  created_at: Millis
  updated_at: Millis
}

export interface MessageTable {
  id: string
  thread_id: string
  seq: number
  author: 'human' | 'agent'
  body: string
  created_at: Millis
  /** Null means draft. Agent messages submit on write. */
  submitted_at: Millis | null
  updated_at: Millis
}

export interface SubmissionTable {
  id: string
  review_id: string
  verdict: 'comment' | 'changes_requested' | 'approved'
  message_count: number
  submitted_at: Millis
}

export interface ApprovalTable {
  id: string
  review_id: string
  snapshot_id: string
  source_id: string
  /** Denormalized from source so the gate can index on content, not on a review. */
  root_path: string
  fingerprint: string
  approved_at: Millis
  /** Stamped the first time a gate call matches. Never invalidates the row. */
  consumed_at: Millis | null
  /** The tree the approved reading would commit, and the commit it sat on. */
  gated_tree: string | null
  gated_head: string | null
}

/**
 * One commit somebody approved, kept apart from the review that carried it.
 *
 * The push gate checks coverage per commit, so a stacked branch does not send
 * its reviewer back through commits an earlier review already passed, and a
 * commit nobody read refuses the push whatever base the review named.
 *
 * Rows outlive the snapshot whose commit list produced them and die with the
 * review, which is what makes coverage compose: a branch stacked on an open
 * review draws on that review's approvals until it is released.
 */
export interface ApprovedCommitTable {
  id: string
  review_id: string
  /** Denormalized from source, so the gate asks about a repository. */
  root_path: string
  sha: string
  /** Null when the client that uploaded the commit could not compute one. */
  patch_id: string | null
  parent_sha: string | null
  approved_at: Millis
}

export interface Database {
  review: ReviewTable
  source: SourceTable
  snapshot: SnapshotTable
  snapshot_source: SnapshotSourceTable
  file_change: FileChangeTable
  commit: CommitTable
  blob: BlobTable
  thread: ThreadTable
  message: MessageTable
  submission: SubmissionTable
  approval: ApprovalTable
  approved_commit: ApprovedCommitTable
}
