import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { newId, now } from './ids.js'
import { migrateToLatest } from './index.js'
import { tempDatabase, type TempDatabase } from './testing.js'

let ctx: TempDatabase

beforeEach(async () => {
  ctx = await tempDatabase()
})

afterEach(async () => {
  await ctx.close()
})

/** Minimal review + source + snapshot, since almost everything hangs off them. */
async function seedReview() {
  const reviewId = newId()
  const sourceId = newId()
  const snapshotId = newId()
  const t = now()

  await ctx.db
    .insertInto('review')
    .values({
      id: reviewId,
      title: 'test review',
      status: 'open',
      created_by: 'test',
      created_at: t,
      last_activity_at: t,
      updated_at: t,
    })
    .execute()

  await ctx.db
    .insertInto('source')
    .values({
      id: sourceId,
      review_id: reviewId,
      label: 'dotfiles',
      root_path: '/tmp/dotfiles',
      vcs: 'git',
      base_ref: 'HEAD',
      ordinal: 0,
    })
    .execute()

  await ctx.db
    .insertInto('snapshot')
    .values({
      id: snapshotId,
      review_id: reviewId,
      seq: 1,
      fingerprint: 'abc123',
      created_at: t,
    })
    .execute()

  return { reviewId, sourceId, snapshotId }
}

describe('schema', () => {
  it('creates every table the spec names', async () => {
    const rows = await sql<{
      name: string
    }>`select name from sqlite_master where type = 'table'`.execute(ctx.db)
    const names = rows.rows.map((r) => r.name)

    for (const table of [
      'review',
      'source',
      'snapshot',
      'file_change',
      'blob',
      'thread',
      'message',
      'submission',
      'approval',
    ]) {
      expect(names, `missing table ${table}`).toContain(table)
    }
  })

  it('enables foreign keys, WAL, and a busy timeout', async () => {
    const fk = await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(ctx.db)
    expect(fk.rows[0]?.foreign_keys).toBe(1)

    const mode = await sql<{ journal_mode: string }>`pragma journal_mode`.execute(ctx.db)
    expect(mode.rows[0]?.journal_mode).toBe('wal')

    const busy = await sql<{ timeout: number }>`pragma busy_timeout`.execute(ctx.db)
    expect(busy.rows[0]?.timeout).toBe(5000)
  })

  it('runs migrations a second time without changing anything', async () => {
    await expect(migrateToLatest(ctx.db)).resolves.toBeUndefined()

    const rows = await sql<{
      name: string
    }>`select name from sqlite_master where type = 'table'`.execute(ctx.db)
    expect(rows.rows.map((r) => r.name)).toContain('approval')
  })
})

describe('constraints', () => {
  it('rejects an enum value outside the CHECK', async () => {
    const t = now()
    await expect(
      ctx.db
        .insertInto('review')
        .values({
          id: newId(),
          title: 'bad status',
          // A value the spec does not define. SQLite has no enum type, so a
          // CHECK constraint is what keeps this out.
          status: 'merged' as never,
          created_by: '',
          created_at: t,
          last_activity_at: t,
          updated_at: t,
        })
        .execute(),
    ).rejects.toThrow(/CHECK constraint failed/i)
  })

  it('rejects a second snapshot with the same seq', async () => {
    const { reviewId } = await seedReview()

    await expect(
      ctx.db
        .insertInto('snapshot')
        .values({
          id: newId(),
          review_id: reviewId,
          seq: 1,
          fingerprint: 'different-content-same-seq',
          created_at: now(),
        })
        .execute(),
    ).rejects.toThrow(/UNIQUE constraint failed/i)
  })

  it('rejects a message reusing a seq inside one thread', async () => {
    const { reviewId, sourceId, snapshotId } = await seedReview()
    const threadId = newId()
    const t = now()

    await ctx.db
      .insertInto('thread')
      .values({
        id: threadId,
        review_id: reviewId,
        source_id: sourceId,
        path: 'src/a.ts',
        side: 'new',
        line: 42,
        anchor_hash: 'h',
        context_hash: 'c',
        state: 'active',
        origin: 'human',
        drifted: 0,
        first_seen_snapshot: snapshotId,
        last_seen_snapshot: snapshotId,
        created_at: t,
        updated_at: t,
      })
      .execute()

    const message = {
      thread_id: threadId,
      seq: 1,
      author: 'human' as const,
      body: 'first',
      created_at: t,
      submitted_at: null,
      updated_at: t,
    }

    await ctx.db
      .insertInto('message')
      .values({ ...message, id: newId() })
      .execute()

    await expect(
      ctx.db
        .insertInto('message')
        .values({ ...message, id: newId(), body: 'second' })
        .execute(),
    ).rejects.toThrow(/UNIQUE constraint failed/i)
  })

  it('rejects a source pointing at a review that does not exist', async () => {
    await expect(
      ctx.db
        .insertInto('source')
        .values({
          id: newId(),
          review_id: newId(),
          label: 'orphan',
          root_path: '/tmp/orphan',
          vcs: 'git',
          base_ref: 'HEAD',
          ordinal: 0,
        })
        .execute(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i)
  })
})

describe('cascade', () => {
  it('takes sources, snapshots, threads, messages, and approvals with the review', async () => {
    const { reviewId, sourceId, snapshotId } = await seedReview()
    const threadId = newId()
    const t = now()

    await ctx.db
      .insertInto('thread')
      .values({
        id: threadId,
        review_id: reviewId,
        source_id: sourceId,
        path: 'src/a.ts',
        side: 'new',
        line: 1,
        anchor_hash: 'h',
        context_hash: 'c',
        state: 'active',
        origin: 'human',
        drifted: 0,
        first_seen_snapshot: snapshotId,
        last_seen_snapshot: snapshotId,
        created_at: t,
        updated_at: t,
      })
      .execute()

    await ctx.db
      .insertInto('message')
      .values({
        id: newId(),
        thread_id: threadId,
        seq: 1,
        author: 'human',
        body: 'rename this',
        created_at: t,
        submitted_at: t,
        updated_at: t,
      })
      .execute()

    await ctx.db
      .insertInto('approval')
      .values({
        id: newId(),
        review_id: reviewId,
        snapshot_id: snapshotId,
        source_id: sourceId,
        root_path: '/tmp/dotfiles',
        fingerprint: 'abc123',
        approved_at: t,
        consumed_at: null,
      })
      .execute()

    await ctx.db.deleteFrom('review').where('id', '=', reviewId).execute()

    for (const table of ['source', 'snapshot', 'thread', 'message', 'approval'] as const) {
      const left = await sql<{ n: number }>`select count(*) as n from ${sql.table(table)}`.execute(
        ctx.db,
      )
      expect(left.rows[0]?.n, `${table} survived the review`).toBe(0)
    }
  })

  it('leaves blobs behind, because they are shared and swept separately', async () => {
    const { reviewId, sourceId, snapshotId } = await seedReview()
    const blobId = 'sha256-of-something'

    await ctx.db
      .insertInto('blob')
      .values({ id: blobId, bytes: Buffer.from('hello'), size: 5 })
      .execute()

    await ctx.db
      .insertInto('file_change')
      .values({
        id: newId(),
        snapshot_id: snapshotId,
        source_id: sourceId,
        path: 'src/a.ts',
        change_type: 'modified',
        old_path: null,
        old_blob_id: null,
        new_blob_id: blobId,
        is_binary: 0,
        truncated: 0,
      })
      .execute()

    await ctx.db.deleteFrom('review').where('id', '=', reviewId).execute()

    const changes = await ctx.db.selectFrom('file_change').selectAll().execute()
    expect(changes).toHaveLength(0)

    // Content-addressed rows outlive any one review on purpose: another review
    // may reference the same bytes. The sweep collects them once nothing does.
    const blobs = await ctx.db.selectFrom('blob').selectAll().execute()
    expect(blobs).toHaveLength(1)
  })
})

describe('round trip', () => {
  it('stores blob bytes without mangling them', async () => {
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a, 0x7f])
    await ctx.db
      .insertInto('blob')
      .values({ id: 'binary-ish', bytes, size: bytes.length })
      .execute()

    const row = await ctx.db
      .selectFrom('blob')
      .selectAll()
      .where('id', '=', 'binary-ish')
      .executeTakeFirstOrThrow()

    expect(Buffer.from(row.bytes).equals(bytes)).toBe(true)
    expect(row.size).toBe(6)
  })

  it('keeps a null submitted_at distinct from a stamped one', async () => {
    const { reviewId, sourceId, snapshotId } = await seedReview()
    const threadId = newId()
    const t = now()

    await ctx.db
      .insertInto('thread')
      .values({
        id: threadId,
        review_id: reviewId,
        source_id: sourceId,
        path: 'src/a.ts',
        side: 'new',
        line: 7,
        anchor_hash: 'h',
        context_hash: 'c',
        state: 'active',
        origin: 'human',
        drifted: 0,
        first_seen_snapshot: snapshotId,
        last_seen_snapshot: snapshotId,
        created_at: t,
        updated_at: t,
      })
      .execute()

    await ctx.db
      .insertInto('message')
      .values([
        {
          id: newId(),
          thread_id: threadId,
          seq: 1,
          author: 'human',
          body: 'draft, not sent',
          created_at: t,
          submitted_at: null,
          updated_at: t,
        },
        {
          id: newId(),
          thread_id: threadId,
          seq: 2,
          author: 'agent',
          body: 'agent messages submit on write',
          created_at: t,
          submitted_at: t,
          updated_at: t,
        },
      ])
      .execute()

    const drafts = await ctx.db
      .selectFrom('message')
      .selectAll()
      .where('submitted_at', 'is', null)
      .execute()

    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.body).toBe('draft, not sent')
  })
})
