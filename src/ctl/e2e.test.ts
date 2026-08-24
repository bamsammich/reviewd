import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from '../daemon/config.js'
import { tempDatabase, type TempDatabase } from '../daemon/db/testing.js'
import { createApp, type App } from '../daemon/http/app.js'
import { Client } from './client.js'
import { fingerprint } from './git.js'
import { pushSnapshot } from './push.js'
import { tempRepo, type TempRepo } from './testing.js'

/**
 * The whole loop, end to end: two real git repositories, the real client, and
 * the real daemon. Everything in between is the code that ships.
 *
 * This is the test that would have caught the diffx bugs. Concurrent reviews
 * of different roots, an approval bound to content rather than to a review,
 * and a comment on a change that spans two repositories at once.
 */

let ctx: TempDatabase
let app: App
let client: Client
let repoA: TempRepo
let repoB: TempRepo

beforeEach(async () => {
  ctx = await tempDatabase()
  const config = resolve(configSchema.parse({ public_url: 'https://mac.tailnet-name.ts.net' }), {
    configPath: '/tmp/reviewd-e2e.json',
    bindPublic: false,
  })
  app = createApp({ config, db: ctx.db, local: true })

  // The client speaks to the app directly, so every middleware and route in
  // the request path is the one the daemon runs.
  client = new Client('http://127.0.0.1:7777', (input, init) =>
    app.request(String(input).replace('http://127.0.0.1:7777', ''), {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), host: '127.0.0.1:7777' },
    }),
  )

  repoA = tempRepo()
  repoA.write('src/app.ts', 'const a = 1\nconst b = 2\nconst c = 3\n')
  repoA.commit('initial')

  repoB = tempRepo()
  repoB.write('config.json', '{\n  "debug": false\n}\n')
  repoB.commit('initial')
})

afterEach(async () => {
  repoA.cleanup()
  repoB.cleanup()
  await ctx.close()
})

describe('one review across two repositories', () => {
  it('runs create, push, comment, submit, approve, and gate', async () => {
    repoA.write('src/app.ts', 'const a = 1\nconst b = 99\nconst c = 3\n')
    repoB.write('config.json', '{\n  "debug": true\n}\n')

    const review = await client.createReview({
      title: 'flip debug on and bump b',
      sources: [
        { path: repoA.root, base: 'HEAD', includeUntracked: true },
        { path: repoB.root, base: 'HEAD', label: 'config', includeUntracked: true },
      ],
      createdBy: 'e2e',
      notify: false,
    })

    expect(review.sources).toHaveLength(2)
    expect(review.url).toContain('https://mac.tailnet-name.ts.net/r/')

    const snapshot = await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repoA.root, baseRef: 'HEAD' },
      { id: review.sources[1]!.id, rootPath: repoB.root, baseRef: 'HEAD' },
    ])

    // One snapshot, one file from each repository.
    expect(snapshot.seq).toBe(1)
    expect(snapshot.fileCount).toBe(2)

    // The reviewer comments on one root and the agent asks about the other.
    await client.createThread(review.reviewId, {
      sourceId: review.sources[0]!.id,
      path: 'src/app.ts',
      line: 2,
      side: 'new',
      body: 'why 99?',
      author: 'human',
    })

    await client.createThread(review.reviewId, {
      sourceId: review.sources[1]!.id,
      path: 'config.json',
      line: 2,
      side: 'new',
      body: 'I turned debug on to match the ticket, worth a check',
      author: 'agent',
    })

    // The reviewer's comment is a draft, so only the agent's own is visible.
    expect(await client.listThreads(review.reviewId)).toHaveLength(1)
    expect(await client.listThreads(review.reviewId, { drafts: true })).toHaveLength(2)

    const gateBefore = await client.gate(repoA.root, await fingerprint(repoA.root))
    expect(gateBefore.decision).toBe('deny')

    await client.submit(review.reviewId, 'changes_requested')

    const owed = await client.listThreads(review.reviewId, { turn: 'agent' })
    expect(owed).toHaveLength(1)
    expect(owed[0]?.messages[0]?.body).toBe('why 99?')

    await client.reply(owed[0]!.id, 'the ticket asked for 99')
    expect(await client.listThreads(review.reviewId, { turn: 'agent' })).toHaveLength(0)

    await client.submit(review.reviewId, 'approved')

    // Each root is gated on its own fingerprint.
    for (const repo of [repoA, repoB]) {
      const result = await client.gate(repo.root, await fingerprint(repo.root))
      expect(result.decision, repo.root).toBe('allow')
    }
  })

  it('re-arms the gate when the tree moves after approval', async () => {
    repoA.write('src/app.ts', 'const a = 1\nconst b = 99\nconst c = 3\n')

    const review = await client.createReview({
      title: 'one root',
      sources: [{ path: repoA.root, base: 'HEAD', includeUntracked: true }],
      createdBy: 'e2e',
      notify: false,
    })

    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repoA.root, baseRef: 'HEAD' },
    ])
    await client.submit(review.reviewId, 'approved')

    expect((await client.gate(repoA.root, await fingerprint(repoA.root))).decision).toBe('allow')

    // An edit after approval is exactly the case the fingerprint exists for.
    repoA.write('src/app.ts', 'const a = 1\nconst b = 100\nconst c = 3\n')

    const after = await client.gate(repoA.root, await fingerprint(repoA.root))
    expect(after.decision).toBe('deny')
    expect(after.reason).toMatch(/approved at snapshot 1/)
  })

  it('keeps two concurrent reviews of different roots apart', async () => {
    repoA.write('src/app.ts', 'const a = 2\n')
    repoB.write('config.json', '{"debug": true}\n')

    const first = await client.createReview({
      title: 'session one',
      sources: [{ path: repoA.root, base: 'HEAD', includeUntracked: true }],
      createdBy: 'session-1',
      notify: false,
    })
    const second = await client.createReview({
      title: 'session two',
      sources: [{ path: repoB.root, base: 'HEAD', includeUntracked: true }],
      createdBy: 'session-2',
      notify: false,
    })

    await pushSnapshot(client, first.reviewId, [
      { id: first.sources[0]!.id, rootPath: repoA.root, baseRef: 'HEAD' },
    ])
    await pushSnapshot(client, second.reviewId, [
      { id: second.sources[0]!.id, rootPath: repoB.root, baseRef: 'HEAD' },
    ])

    await client.submit(first.reviewId, 'approved')

    // Approving one session's review must not clear the other's commit, which
    // is the bug a port-addressed review server has.
    expect((await client.gate(repoA.root, await fingerprint(repoA.root))).decision).toBe('allow')
    expect((await client.gate(repoB.root, await fingerprint(repoB.root))).decision).toBe('deny')
  })

  it('uploads only what changed on a second snapshot', async () => {
    repoA.write('src/app.ts', 'const a = 2\n')

    const review = await client.createReview({
      title: 'twice',
      sources: [{ path: repoA.root, base: 'HEAD', includeUntracked: true }],
      createdBy: 'e2e',
      notify: false,
    })

    const source = { id: review.sources[0]!.id, rootPath: repoA.root, baseRef: 'HEAD' }
    await pushSnapshot(client, review.reviewId, [source])

    const blobsAfterFirst = await ctx.db.selectFrom('blob').selectAll().execute()

    repoA.write('src/second.ts', 'const s = 1\n')
    const second = await pushSnapshot(client, review.reviewId, [source])

    expect(second.seq).toBe(2)
    const blobsAfterSecond = await ctx.db.selectFrom('blob').selectAll().execute()
    // The unchanged file's content was already stored, so only the new file's
    // bytes arrived.
    expect(blobsAfterSecond.length).toBe(blobsAfterFirst.length + 1)
  })

  it('wakes a wait once when the reviewer submits three comments', async () => {
    repoA.write('src/app.ts', 'const a = 2\nconst b = 3\nconst c = 4\n')

    const review = await client.createReview({
      title: 'batched',
      sources: [{ path: repoA.root, base: 'HEAD', includeUntracked: true }],
      createdBy: 'e2e',
      notify: false,
    })

    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repoA.root, baseRef: 'HEAD' },
    ])

    for (const line of [1, 2, 3]) {
      await client.createThread(review.reviewId, {
        path: 'src/app.ts',
        line,
        side: 'new',
        body: `comment on line ${line}`,
        author: 'human',
      })
    }

    const waiting = client.wait(review.reviewId, 3000, Date.now())
    await new Promise((r) => setTimeout(r, 20))
    await client.submit(review.reviewId, 'changes_requested')

    const woke = await waiting
    expect(woke.wokeOn).toBe('submission')
    expect(woke.verdict).toBe('changes_requested')
    expect(woke.threadsAwaitingAgent).toBe(3)
  })
})
