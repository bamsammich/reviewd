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

export const migrations: Record<string, Migration> = {
  '0001_initial': initial,
}

export class CodeMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations
  }
}
