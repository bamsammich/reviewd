import { sql, type Kysely } from 'kysely'
import type { Migration, MigrationProvider } from 'kysely/migration'

/**
 * Migrations run before the typed schema exists, so kysely types their handle
 * as `Kysely<any>`. Narrowing it here would fight the library rather than buy
 * safety: every statement below is DDL, which the schema builder checks itself.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type MigrationDb = Kysely<any>

/**
 * Migrations live in code rather than in loose SQL files so that one `npm test`
 * exercises the same DDL the daemon runs at startup.
 */

const initial: Migration = {
  async up(db: MigrationDb): Promise<void> {
    await db.schema
      .createTable('review')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('status', 'text', (c) =>
        c
          .notNull()
          .defaultTo('open')
          .check(sql`status in ('open','approved')`),
      )
      .addColumn('created_by', 'text', (c) => c.notNull().defaultTo(''))
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addColumn('last_activity_at', 'integer', (c) => c.notNull())
      .addColumn('updated_at', 'integer', (c) => c.notNull())
      .execute()

    // The sweep scans on this, and it is the only query that touches every review.
    await db.schema
      .createIndex('review_last_activity_idx')
      .on('review')
      .column('last_activity_at')
      .execute()

    await db.schema
      .createTable('source')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('review_id', 'text', (c) =>
        c.notNull().references('review.id').onDelete('cascade'),
      )
      .addColumn('label', 'text', (c) => c.notNull())
      .addColumn('root_path', 'text', (c) => c.notNull())
      .addColumn('vcs', 'text', (c) => c.notNull().check(sql`vcs in ('git','none')`))
      .addColumn('base_ref', 'text')
      .addColumn('ordinal', 'integer', (c) => c.notNull().defaultTo(0))
      .execute()

    await db.schema.createIndex('source_review_idx').on('source').column('review_id').execute()
    await db.schema.createIndex('source_root_idx').on('source').column('root_path').execute()

    await db.schema
      .createTable('snapshot')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('review_id', 'text', (c) =>
        c.notNull().references('review.id').onDelete('cascade'),
      )
      .addColumn('seq', 'integer', (c) => c.notNull())
      .addColumn('fingerprint', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addUniqueConstraint('snapshot_review_seq_unique', ['review_id', 'seq'])
      .execute()

    // A snapshot covers every source at once, but each source carries its own
    // fingerprint, because the gate asks about one repository at a time and an
    // approval is per source root.
    await db.schema
      .createTable('snapshot_source')
      .addColumn('snapshot_id', 'text', (c) =>
        c.notNull().references('snapshot.id').onDelete('cascade'),
      )
      .addColumn('source_id', 'text', (c) =>
        c.notNull().references('source.id').onDelete('cascade'),
      )
      .addColumn('fingerprint', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('snapshot_source_pk', ['snapshot_id', 'source_id'])
      .execute()

    // Content-addressed, so the same bytes across snapshots and reviews store once.
    await db.schema
      .createTable('blob')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('bytes', 'blob', (c) => c.notNull())
      .addColumn('size', 'integer', (c) => c.notNull())
      .execute()

    await db.schema
      .createTable('file_change')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('snapshot_id', 'text', (c) =>
        c.notNull().references('snapshot.id').onDelete('cascade'),
      )
      .addColumn('source_id', 'text', (c) =>
        c.notNull().references('source.id').onDelete('cascade'),
      )
      .addColumn('path', 'text', (c) => c.notNull())
      .addColumn('change_type', 'text', (c) =>
        c.notNull().check(sql`change_type in ('added','modified','deleted','renamed','binary')`),
      )
      .addColumn('old_path', 'text')
      .addColumn('old_blob_id', 'text', (c) => c.references('blob.id'))
      .addColumn('new_blob_id', 'text', (c) => c.references('blob.id'))
      .addColumn('is_binary', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('truncated', 'integer', (c) => c.notNull().defaultTo(0))
      .execute()

    await db.schema
      .createIndex('file_change_snapshot_idx')
      .on('file_change')
      .column('snapshot_id')
      .execute()

    // The blob sweep asks "does any file_change still point at this id", once
    // per orphan candidate, so both directions need an index.
    await db.schema
      .createIndex('file_change_old_blob_idx')
      .on('file_change')
      .column('old_blob_id')
      .execute()
    await db.schema
      .createIndex('file_change_new_blob_idx')
      .on('file_change')
      .column('new_blob_id')
      .execute()

    await db.schema
      .createTable('thread')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('review_id', 'text', (c) =>
        c.notNull().references('review.id').onDelete('cascade'),
      )
      .addColumn('source_id', 'text', (c) =>
        c.notNull().references('source.id').onDelete('cascade'),
      )
      .addColumn('path', 'text', (c) => c.notNull())
      .addColumn('side', 'text', (c) => c.notNull().check(sql`side in ('old','new')`))
      .addColumn('line', 'integer', (c) => c.notNull())
      .addColumn('anchor_hash', 'text', (c) => c.notNull())
      .addColumn('context_hash', 'text', (c) => c.notNull())
      .addColumn('state', 'text', (c) =>
        c
          .notNull()
          .defaultTo('active')
          .check(sql`state in ('active','resolved','outdated')`),
      )
      .addColumn('origin', 'text', (c) => c.notNull().check(sql`origin in ('human','agent')`))
      .addColumn('drifted', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('first_seen_snapshot', 'text', (c) => c.notNull())
      .addColumn('last_seen_snapshot', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addColumn('updated_at', 'integer', (c) => c.notNull())
      .execute()

    await db.schema.createIndex('thread_review_idx').on('thread').column('review_id').execute()

    await db.schema
      .createTable('message')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('thread_id', 'text', (c) =>
        c.notNull().references('thread.id').onDelete('cascade'),
      )
      .addColumn('seq', 'integer', (c) => c.notNull())
      .addColumn('author', 'text', (c) => c.notNull().check(sql`author in ('human','agent')`))
      .addColumn('body', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addColumn('submitted_at', 'integer')
      .addColumn('updated_at', 'integer', (c) => c.notNull())
      .addUniqueConstraint('message_thread_seq_unique', ['thread_id', 'seq'])
      .execute()

    await db.schema.createIndex('message_thread_idx').on('message').column('thread_id').execute()

    await db.schema
      .createTable('submission')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('review_id', 'text', (c) =>
        c.notNull().references('review.id').onDelete('cascade'),
      )
      .addColumn('verdict', 'text', (c) =>
        c.notNull().check(sql`verdict in ('comment','changes_requested','approved')`),
      )
      .addColumn('message_count', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('submitted_at', 'integer', (c) => c.notNull())
      .execute()

    await db.schema
      .createIndex('submission_review_idx')
      .on('submission')
      .column('review_id')
      .execute()

    await db.schema
      .createTable('approval')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('review_id', 'text', (c) =>
        c.notNull().references('review.id').onDelete('cascade'),
      )
      .addColumn('snapshot_id', 'text', (c) =>
        c.notNull().references('snapshot.id').onDelete('cascade'),
      )
      .addColumn('source_id', 'text', (c) =>
        c.notNull().references('source.id').onDelete('cascade'),
      )
      .addColumn('root_path', 'text', (c) => c.notNull())
      .addColumn('fingerprint', 'text', (c) => c.notNull())
      .addColumn('approved_at', 'integer', (c) => c.notNull())
      .addColumn('consumed_at', 'integer')
      .execute()

    // The gate's only query. Matching on content rather than on a review id is
    // what keeps concurrent reviews of the same root from authorizing each other.
    await db.schema
      .createIndex('approval_root_fingerprint_idx')
      .on('approval')
      .columns(['root_path', 'fingerprint'])
      .execute()
  },

  async down(db: MigrationDb): Promise<void> {
    for (const table of [
      'approval',
      'snapshot_source',
      'submission',
      'message',
      'thread',
      'file_change',
      'blob',
      'snapshot',
      'source',
      'review',
    ]) {
      await db.schema.dropTable(table).ifExists().execute()
    }
  },
}

/**
 * Comments that cover a range of lines rather than one.
 *
 * Both columns are nullable and a null `end_line` means what every existing
 * thread means: one line, behaving exactly as before. So there is nothing to
 * backfill.
 *
 * `end_anchor_hash` is not redundant with the length. Re-anchoring finds the
 * start by hashing it and looking for that hash in the new content; carrying a
 * length alone would then place the end by arithmetic with no way to tell
 * whether the end still exists or the middle simply grew. Hashing the last line
 * too is what makes "the range survived intact" answerable.
 */
const lineRanges: Migration = {
  async up(db: MigrationDb): Promise<void> {
    await db.schema.alterTable('thread').addColumn('end_line', 'integer').execute()
    await db.schema.alterTable('thread').addColumn('end_anchor_hash', 'text').execute()
  },

  async down(db: MigrationDb): Promise<void> {
    await db.schema.alterTable('thread').dropColumn('end_anchor_hash').execute()
    await db.schema.alterTable('thread').dropColumn('end_line').execute()
  },
}

/**
 * What the gate authorized, so `reviewd observe` can compare it to what landed.
 *
 * `gated_tree` is the tree the approved reading would have committed, and
 * `gated_head` the commit it sat on. Nullable because every approval written
 * before this migration has neither, and an approval that cannot answer is
 * reported as unknown rather than as clean.
 */
const gatedTree: Migration = {
  async up(db: MigrationDb): Promise<void> {
    await db.schema.alterTable('approval').addColumn('gated_tree', 'text').execute()
    await db.schema.alterTable('approval').addColumn('gated_head', 'text').execute()
  },

  async down(db: MigrationDb): Promise<void> {
    await db.schema.alterTable('approval').dropColumn('gated_head').execute()
    await db.schema.alterTable('approval').dropColumn('gated_tree').execute()
  },
}

/**
 * Threads that belong to the review rather than to a line.
 *
 * Plenty of review feedback is not about a line: the approach is right and the
 * naming is off, or why this shape rather than that one. Anchoring those to an
 * arbitrary line is worse than leaving them unanchored, because the next
 * snapshot re-anchors or outdates a comment that was never about that code.
 *
 * SQLite cannot drop a NOT NULL, so the table is rebuilt. Every existing row
 * keeps its anchor; only the constraint changes.
 */
const reviewLevelThreads: Migration = {
  async up(db: MigrationDb): Promise<void> {
    // The rebuild order matters. Renaming `thread` first rewrites
    // `message.thread_id` to point at the renamed table, and dropping it then
    // leaves the foreign key naming a table that is gone. Building beside it
    // and renaming into place last keeps every reference on `thread`.
    await sql`PRAGMA foreign_keys = OFF`.execute(db)

    await db.schema
      .createTable('thread_rebuilt')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('review_id', 'text', (c) =>
        c.notNull().references('review.id').onDelete('cascade'),
      )
      .addColumn('source_id', 'text')
      .addColumn('path', 'text')
      .addColumn('side', 'text')
      .addColumn('line', 'integer')
      .addColumn('anchor_hash', 'text')
      .addColumn('context_hash', 'text')
      .addColumn('end_line', 'integer')
      .addColumn('end_anchor_hash', 'text')
      .addColumn('state', 'text', (c) => c.notNull())
      .addColumn('origin', 'text', (c) => c.notNull())
      .addColumn('drifted', 'integer', (c) => c.notNull())
      .addColumn('first_seen_snapshot', 'text', (c) => c.notNull())
      .addColumn('last_seen_snapshot', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addColumn('updated_at', 'integer', (c) => c.notNull())
      .execute()

    await sql`
      INSERT INTO thread_rebuilt
      SELECT id, review_id, source_id, path, side, line, anchor_hash, context_hash,
             end_line, end_anchor_hash, state, origin, drifted,
             first_seen_snapshot, last_seen_snapshot, created_at, updated_at
      FROM thread
    `.execute(db)

    await db.schema.dropTable('thread').execute()
    await db.schema.alterTable('thread_rebuilt').renameTo('thread').execute()

    await sql`PRAGMA foreign_keys = ON`.execute(db)
  },

  async down(): Promise<void> {
    throw new Error(
      '0004_review_level_threads cannot be undone: a thread on no line has nowhere to go',
    )
  },
}

/**
 * The commits a snapshot covers, and which one each file change belongs to.
 *
 * A push carries commits and the review showed their sum, which is the whole
 * change and none of the author's division of it. Reading commit by commit is
 * the point of gating late.
 *
 * The daemon cannot work any of this out for itself: it never runs git and
 * cannot see the repository, so a commit and its change set arrive the way
 * everything else does, computed by the client and uploaded.
 *
 * `commit_id` is nullable and the combined change set keeps it null. Rows the
 * page already draws are untouched, and a review created before this migration
 * carries no commits and renders exactly as it did.
 */
const commitScopes: Migration = {
  async up(db: MigrationDb): Promise<void> {
    await db.schema
      .createTable('commit')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('snapshot_id', 'text', (c) =>
        c.notNull().references('snapshot.id').onDelete('cascade'),
      )
      .addColumn('source_id', 'text', (c) =>
        c.notNull().references('source.id').onDelete('cascade'),
      )
      .addColumn('sha', 'text', (c) => c.notNull())
      .addColumn('subject', 'text', (c) => c.notNull())
      .addColumn('author', 'text', (c) => c.notNull())
      .addColumn('committed_at', 'integer', (c) => c.notNull())
      // Oldest first, so the page lists them in the order they were written
      // rather than in whatever order rev-list returned.
      .addColumn('ordinal', 'integer', (c) => c.notNull())
      .execute()

    await db.schema
      .createIndex('commit_snapshot')
      .on('commit')
      .columns(['snapshot_id', 'ordinal'])
      .execute()

    await db.schema.alterTable('file_change').addColumn('commit_id', 'text').execute()

    // Every read of a commit's files asks this question and only this one.
    await db.schema
      .createIndex('file_change_commit')
      .on('file_change')
      .columns(['commit_id'])
      .execute()
  },

  async down(db: MigrationDb): Promise<void> {
    await db.schema.dropIndex('file_change_commit').execute()
    await db.schema.alterTable('file_change').dropColumn('commit_id').execute()
    await db.schema.dropIndex('commit_snapshot').execute()
    await db.schema.dropTable('commit').execute()
  },
}

/**
 * Which commit a comment was left on, for a review that carries commits.
 *
 * Null is the combined change set, which is where every comment written before
 * this one lives and where a comment on a review of a working tree still goes.
 * A sha rather than a foreign key to `commit`: commit rows belong to one
 * snapshot and are replaced wholesale by the next, while a comment outlives
 * the revision it was written against. The sha is what stays true across both.
 */
const commitComments: Migration = {
  async up(db: MigrationDb): Promise<void> {
    await db.schema.alterTable('thread').addColumn('commit_sha', 'text').execute()

    // Every read of a commit's threads asks this and only this: which comments
    // belong on the view being drawn.
    await db.schema
      .createIndex('thread_commit')
      .on('thread')
      .columns(['review_id', 'commit_sha'])
      .execute()
  },

  async down(db: MigrationDb): Promise<void> {
    await db.schema.dropIndex('thread_commit').execute()
    await db.schema.alterTable('thread').dropColumn('commit_sha').execute()
  },
}

export const migrations: Record<string, Migration> = {
  '0001_initial': initial,
  '0002_line_ranges': lineRanges,
  '0003_gated_tree': gatedTree,
  '0004_review_level_threads': reviewLevelThreads,
  '0005_commit_scopes': commitScopes,
  '0006_commit_comments': commitComments,
}

export class CodeMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations
  }
}
