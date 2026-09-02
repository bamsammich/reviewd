import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from '../daemon/config.js'
import { tempDatabase, type TempDatabase } from '../daemon/db/testing.js'
import { createApp, type App } from '../daemon/http/app.js'
import { Client } from './client.js'
import { diffCommitRange, pushRange } from './diff.js'
import { pushSnapshot } from './push.js'
import { tempRepo, type TempRepo } from './testing.js'

/**
 * What a revision describes, against how the repository is gated.
 *
 * The two have to agree. An approval covers a fingerprint, and the gate
 * arrives with the one it computed itself: under push gating that is the
 * commits an upstream has not seen, and a review of the working tree holds an
 * approval the gate can never match. The reviewer says yes and the push is
 * refused anyway, with nothing on either side saying why.
 */

let ctx: TempDatabase
let repo: TempRepo

beforeEach(async () => {
  ctx = await tempDatabase()

  repo = tempRepo()
  repo.write('src/a.ts', 'const a = 1\n')
  repo.commit('initial')
  repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD')
})

afterEach(async () => {
  repo.cleanup()
  await ctx.close()
})

/** A daemon that gates this repository the way the test is about. */
function daemon(scope: 'commit' | 'push'): { app: App; client: Client } {
  const config = resolve(
    configSchema.parse({
      public_url: 'https://mac.tailnet-name.ts.net',
      gate: { scope, roots: {} },
    }),
    { configPath: '/tmp/reviewd-push-scope.json', bindPublic: false },
  )

  const app = createApp({ config, db: ctx.db, local: true })
  const client = new Client('http://127.0.0.1:7777', (input, init) =>
    app.request(String(input).replace('http://127.0.0.1:7777', ''), {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), host: '127.0.0.1:7777' },
    }),
  )

  return { app, client }
}

async function reviewOf(client: Client) {
  return client.createReview({
    title: 'a push',
    sources: [{ path: repo.root, base: 'HEAD' }],
    createdBy: 'test',
    notify: false,
  })
}

/** Two commits and an edit on top, so the two readings cannot coincide. */
function twoCommitsAndAnEdit(): void {
  repo.write('src/a.ts', 'const a = 2\n')
  repo.commit('to two')
  repo.write('src/b.ts', 'const b = 1\n')
  repo.commit('add b')
  repo.write('src/c.ts', 'uncommitted\n')
}

describe('a revision under push gating', () => {
  it('describes the commits being pushed, not the working tree', async () => {
    const { client } = daemon('push')
    const review = await reviewOf(client)
    twoCommitsAndAnEdit()

    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repo.root, baseRef: 'HEAD' },
    ])

    const snapshot = await ctx.db.selectFrom('snapshot').selectAll().executeTakeFirstOrThrow()
    const files = await ctx.db
      .selectFrom('file_change')
      .selectAll()
      .where('commit_id', 'is', null)
      .execute()

    // src/c.ts is edited and not committed, so it is not being pushed and is
    // not part of what the reviewer is asked to approve.
    expect(files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts'])

    // The number the gate will arrive with, computed the way the gate computes
    // it. This is the whole reason the daemon is asked which scope applies.
    const range = (await pushRange(repo.root))!
    const gated = await diffCommitRange({ id: review.sources[0]!.id, rootPath: repo.root }, range)
    const stored = await ctx.db
      .selectFrom('snapshot_source')
      .selectAll()
      .where('snapshot_id', '=', snapshot.id)
      .executeTakeFirstOrThrow()

    expect(stored.fingerprint).toBe(gated.fingerprint)
  })

  it('lists the commits, oldest first, each with what it alone changed', async () => {
    const { client } = daemon('push')
    const review = await reviewOf(client)
    twoCommitsAndAnEdit()

    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repo.root, baseRef: 'HEAD' },
    ])

    const commits = await ctx.db.selectFrom('commit').selectAll().orderBy('ordinal').execute()
    expect(commits.map((c) => c.subject)).toEqual(['to two', 'add b'])
    expect(commits.map((c) => c.author)).toEqual(['test', 'test'])

    const rows = await ctx.db
      .selectFrom('file_change')
      .selectAll()
      .where('commit_id', '=', commits[1]!.id)
      .execute()

    expect(rows.map((r) => r.path)).toEqual(['src/b.ts'])
  })

  it('reads the working tree when the branch has nothing to push', async () => {
    // Nothing to gate and nothing to divide, and a reviewer opening the page
    // before committing still wants to read what is there.
    const { client } = daemon('push')
    const review = await reviewOf(client)
    repo.write('src/c.ts', 'uncommitted\n')

    const result = await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repo.root, baseRef: 'HEAD' },
    ])

    expect(result.fileCount).toBe(1)
    expect(await ctx.db.selectFrom('commit').selectAll().execute()).toEqual([])
  })
})

describe('a revision under commit gating', () => {
  it('describes the working tree and divides it into nothing', async () => {
    const { client } = daemon('commit')
    const review = await reviewOf(client)
    twoCommitsAndAnEdit()

    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repo.root, baseRef: 'HEAD' },
    ])

    const files = await ctx.db.selectFrom('file_change').selectAll().execute()

    // Against HEAD, which is what a commit would record: the two commits are
    // already in HEAD and only the uncommitted file is left.
    expect(files.map((f) => f.path)).toEqual(['src/c.ts'])
    expect(await ctx.db.selectFrom('commit').selectAll().execute()).toEqual([])
  })
})
