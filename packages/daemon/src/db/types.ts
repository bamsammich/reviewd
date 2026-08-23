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
}

export interface SnapshotTable {
  id: string
  review_id: string
  seq: number
  fingerprint: string
  created_at: Millis
}

export interface FileChangeTable {
  id: string
  snapshot_id: string
  source_id: string
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
  source_id: string
  path: string
  side: 'old' | 'new'
  line: number
  anchor_hash: string
  context_hash: string
  /**
   * Whether the conversation is live. Whose turn it is stays derived from the
   * last message, so no column here can drift away from the message list.
   */
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
}

export interface Database {
  review: ReviewTable
  source: SourceTable
  snapshot: SnapshotTable
  snapshot_source: SnapshotSourceTable
  file_change: FileChangeTable
  blob: BlobTable
  thread: ThreadTable
  message: MessageTable
  submission: SubmissionTable
  approval: ApprovalTable
}
