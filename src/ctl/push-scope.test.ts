import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from '../daemon/config.js'
import { tempDatabase, type TempDatabase } from '../daemon/db/testing.js'
import { createApp, type App } from '../daemon/http/app.js'
import { Client } from './client.js'
import { diffCommitRange, pushRange } from './diff.js'
import { pushSnapshot } from './push.js'
import { tempRepo, type TempRepo } from './testing.js'

/**
 * What a revision describes, against how the repository is gated and what the
 * caller asked for.
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
      // No base, which is how a caller asks for the reading the gate uses.
      { id: review.sources[0]!.id, rootPath: repo.root },
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
      // No base, which is how a caller asks for the reading the gate uses.
      { id: review.sources[0]!.id, rootPath: repo.root },
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
      // No base, which is how a caller asks for the reading the gate uses.
      { id: review.sources[0]!.id, rootPath: repo.root },
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
      // No base, which is how a caller asks for the reading the gate uses.
      { id: review.sources[0]!.id, rootPath: repo.root },
    ])

    const files = await ctx.db.selectFrom('file_change').selectAll().execute()

    // Against HEAD, which is what a commit would record: the two commits are
    // already in HEAD and only the uncommitted file is left.
    expect(files.map((f) => f.path)).toEqual(['src/c.ts'])
    expect(await ctx.db.selectFrom('commit').selectAll().execute()).toEqual([])
  })
})

/**
 * A base the caller named, under a repository gated on push.
 *
 * Reported as issue 41: the review stored the base it was given and diffed the
 * push range anyway, so the page showed every commit on the branch and marked
 * a file from before the base as added.
 *
 * A base answers where a branch begins, which is what stacked work needs. The
 * pull request below this one is already somebody's review, the base is the
 * boundary between the two, and the reading is the commits from there to HEAD.
 * An edit nobody committed stays out, because a push does not carry one.
 *
 * Narrowing a review this way hides nothing from the gate, which reads the
 * push range itself and wants an approval for every commit in it. A commit
 * left out of the review is a commit left unapproved, and
 * `push-approval.test.ts` is where that guarantee is held.
 */
describe('a base the caller named', () => {
  /** Two commits past the base, plus an edit nobody committed. */
  function threeCommitsAndAnEdit(): string {
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('commit A')
    repo.write('src/b.ts', 'const b = 1\n')
    repo.commit('commit B')
    const base = repo.run('rev-parse', 'HEAD').trim()

    repo.write('src/c.ts', 'const c = 1\n')
    repo.commit('commit C')
    repo.write('src/d.ts', 'uncommitted\n')

    return base
  }

  it('reads from that base rather than from where the push starts', async () => {
    const { client } = daemon('push')
    const review = await reviewOf(client)
    const base = threeCommitsAndAnEdit()

    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repo.root, baseRef: base },
    ])

    const files = await ctx.db
      .selectFrom('file_change')
      .select('path')
      .where('commit_id', 'is', null)
      .execute()

    // Commit C alone. Not A or B, which sit behind the base the caller named,
    // and not the uncommitted file, which no push carries.
    expect(files.map((f) => f.path).sort()).toEqual(['src/c.ts'])
  })

  it('leaves a file from before the base out of the review', async () => {
    const { client } = daemon('push')
    const review = await reviewOf(client)
    const base = threeCommitsAndAnEdit()

    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repo.root, baseRef: base },
    ])

    const paths = (
      await ctx.db.selectFrom('file_change').select('path').where('commit_id', 'is', null).execute()
    ).map((f) => f.path)

    expect(paths).not.toContain('src/a.ts')
    expect(paths).not.toContain('src/b.ts')
  })

  // The commits are what the reviewer approves one at a time, so a review
  // narrowed to a base has to list the ones inside it and no others.
  it('lists the commits inside the base, and none behind it', async () => {
    const { client } = daemon('push')
    const review = await reviewOf(client)
    const base = threeCommitsAndAnEdit()

    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repo.root, baseRef: base },
    ])

    const commits = await ctx.db.selectFrom('commit').selectAll().orderBy('ordinal').execute()
    expect(commits.map((c) => c.subject)).toEqual(['commit C'])
  })

  // A rebase rewrites a sha and leaves the change alone, and the approval has
  // to survive that or a stack is re-read after every one.
  it('records what each commit does, so an approval outlives a rebase', async () => {
    const { client } = daemon('push')
    const review = await reviewOf(client)
    const base = threeCommitsAndAnEdit()

    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repo.root, baseRef: base },
    ])

    const commit = await ctx.db.selectFrom('commit').selectAll().executeTakeFirstOrThrow()

    expect(commit.patch_id).toMatch(/^[0-9a-f]{40}$/)
    expect(commit.parent_sha).toBe(base)
  })

  it('still reads the push range when no base is named', async () => {
    const { client } = daemon('push')
    const review = await reviewOf(client)
    threeCommitsAndAnEdit()

    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repo.root },
    ])

    const commits = await ctx.db.selectFrom('commit').selectAll().orderBy('ordinal').execute()
    expect(commits.map((c) => c.subject)).toEqual(['commit A', 'commit B', 'commit C'])
  })
})
