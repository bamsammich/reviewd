import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from '../daemon/config.js'
import { tempDatabase, type TempDatabase } from '../daemon/db/testing.js'
import { createApp, type App } from '../daemon/http/app.js'
import { Client } from './client.js'
import { pushSnapshot } from './push.js'
import { tempRepo, type TempRepo } from './testing.js'

/**
 * A comment left on one commit, after the branch it sat on is rewritten.
 *
 * Matching the commit by sha alone made every such comment outdate on the next
 * revision, because a rebase gives every commit it touches a new sha and
 * leaves the change alone. Revising a stack is mostly rebasing, so commenting
 * on a commit was worth much less than it looked: the note went to the
 * "outdated · code is gone" block while the code it described was still there.
 */

let ctx: TempDatabase
let app: App
let repo: TempRepo

beforeEach(async () => {
  ctx = await tempDatabase()

  repo = tempRepo()
  repo.write('src/a.ts', 'const a = 1\n')
  repo.commit('already pushed')
  repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD')
})

afterEach(async () => {
  repo.cleanup()
  await ctx.close()
})

function daemon(): Client {
  const config = resolve(
    configSchema.parse({
      public_url: 'https://mac.tailnet-name.ts.net',
      gate: { scope: 'push', roots: {} },
    }),
    { configPath: '/tmp/reviewd-comment-rebase.json', bindPublic: false },
  )

  app = createApp({ config, db: ctx.db, local: true })

  return new Client('http://127.0.0.1:7777', (input, init) =>
    app.request(String(input).replace('http://127.0.0.1:7777', ''), {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), host: '127.0.0.1:7777' },
    }),
  )
}

/** A comment as the page writes one, against a line of one commit. */
async function comment(reviewId: string, sourceId: string, commitSha: string): Promise<void> {
  const page = await app.request(`/r/${reviewId}?commit=${commitSha}`, {
    headers: { host: '127.0.0.1:7777' },
  })
  const match = /name="token" value="([^"]+)"/.exec(await page.text())
  if (!match) throw new Error('no page token on the review page')

  await app.request(`/r/${reviewId}/threads`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:7777',
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams({
      token: match[1] as string,
      sourceId,
      path: 'src/work.ts',
      line: '1',
      side: 'new',
      commitSha,
      body: 'Does this handle an empty input?',
    }).toString(),
  })
}

async function open(client: Client) {
  const review = await client.createReview({
    title: 'a stack about to be rebased',
    sources: [{ path: repo.root, base: 'HEAD' }],
    createdBy: 'test',
    notify: false,
  })

  await pushSnapshot(client, review.reviewId, [{ id: review.sources[0]!.id, rootPath: repo.root }])

  return review
}

const snapshot = async (client: Client, review: { reviewId: string; sources: { id: string }[] }) =>
  pushSnapshot(client, review.reviewId, [{ id: review.sources[0]!.id, rootPath: repo.root }])

const threadRow = async () => ctx.db.selectFrom('thread').selectAll().executeTakeFirstOrThrow()

/** Somebody else's work lands upstream, and the branch moves onto it. */
function rebaseOntoUpstream(): void {
  const wasPushed = repo.run('rev-parse', 'origin/main').trim()

  repo.run('checkout', '-q', '-b', 'upstream', wasPushed)
  repo.write('src/theirs.ts', 'export const theirs = 1\n')
  repo.commit('somebody else')
  repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD')
  repo.run('checkout', '-q', 'main')
  repo.run('rebase', '--onto', 'origin/main', wasPushed)
}

describe('a comment on a commit that a rebase rewrote', () => {
  it('stays active, because the change it was written about is still there', async () => {
    const client = daemon()

    repo.write('src/work.ts', 'export const work = 1\n')
    repo.commit('the commit under discussion')
    const before = repo.run('rev-parse', 'HEAD').trim()

    const review = await open(client)
    await comment(review.reviewId, review.sources[0]!.id, before)

    rebaseOntoUpstream()
    expect(repo.run('rev-parse', 'HEAD').trim()).not.toBe(before)

    await snapshot(client, review)

    expect((await threadRow()).state).toBe('active')
  })

  /**
   * The page draws a thread on the commit whose sha it holds, so a comment
   * that followed its change and kept the old sha would re-anchor correctly
   * and then render on no commit at all.
   */
  it('moves onto the sha the commit now has', async () => {
    const client = daemon()

    repo.write('src/work.ts', 'export const work = 1\n')
    repo.commit('the commit under discussion')
    const before = repo.run('rev-parse', 'HEAD').trim()

    const review = await open(client)
    await comment(review.reviewId, review.sources[0]!.id, before)

    rebaseOntoUpstream()
    const after = repo.run('rev-parse', 'HEAD').trim()

    await snapshot(client, review)

    expect((await threadRow()).commit_sha).toBe(after)
  })

  it('reports nothing as outdated', async () => {
    const client = daemon()

    repo.write('src/work.ts', 'export const work = 1\n')
    repo.commit('the commit under discussion')
    const before = repo.run('rev-parse', 'HEAD').trim()

    const review = await open(client)
    await comment(review.reviewId, review.sources[0]!.id, before)

    rebaseOntoUpstream()
    const result = await snapshot(client, review)

    expect(result.threadsOutdated).toBe(0)
  })

  /**
   * A squash changes what each commit does, so nothing in the new revision
   * carries the patch the comment was written against. Outdating is the honest
   * answer there, and it is the answer the sha alone used to give everywhere.
   */
  it('outdates when the commit was squashed into another', async () => {
    const client = daemon()

    repo.write('src/work.ts', 'export const work = 1\n')
    repo.commit('the commit under discussion')
    const before = repo.run('rev-parse', 'HEAD').trim()

    repo.write('src/other.ts', 'export const other = 1\n')
    repo.commit('a second commit')

    const review = await open(client)
    await comment(review.reviewId, review.sources[0]!.id, before)

    // One commit doing what the two did, which is a different patch than
    // either of them.
    repo.run('reset', '-q', '--soft', 'origin/main')
    repo.run('commit', '-q', '-m', 'both at once')

    const result = await snapshot(client, review)

    expect(result.threadsOutdated).toBe(1)
    expect((await threadRow()).state).toBe('outdated')
  })
})
