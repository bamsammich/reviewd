import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from '../daemon/config.js'
import { tempDatabase, type TempDatabase } from '../daemon/db/testing.js'
import { createApp, type App } from '../daemon/http/app.js'
import { Client } from './client.js'
import { diffCommitRange, fingerprint, pushRange } from './diff.js'
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

/**
 * The reviewer acts through the pages, because that is the only place a verdict
 * can come from.
 *
 * The API these tests used before is the agent's, and it cannot approve. Going
 * through the form means the token, the redirect, and the same route a phone
 * would hit are all in the path of every test below.
 */
async function form(path: string, fields: Record<string, string>): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:7777',
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams(fields).toString(),
  })
}

/** Reads the review page the way a reviewer's browser would, token and all. */
async function pageToken(reviewId: string): Promise<string> {
  const page = await app.request(`/r/${reviewId}`, { headers: { host: '127.0.0.1:7777' } })
  const html = await page.text()
  const match = /name="token" value="([^"]+)"/.exec(html)

  if (!match) throw new Error('no page token on the review page')
  return match[1] as string
}

async function reviewerSubmits(reviewId: string, verdict: string): Promise<Response> {
  return form(`/r/${reviewId}/submit`, { verdict, token: await pageToken(reviewId) })
}

async function reviewerComments(
  reviewId: string,
  fields: { sourceId: string; path: string; line: number; body: string },
): Promise<Response> {
  return form(`/r/${reviewId}/threads`, {
    token: await pageToken(reviewId),
    sourceId: fields.sourceId,
    path: fields.path,
    line: String(fields.line),
    side: 'new',
    body: fields.body,
  })
}

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
    await reviewerComments(review.reviewId, {
      sourceId: review.sources[0]!.id,
      path: 'src/app.ts',
      line: 2,
      body: 'why 99?',
    })

    await client.createThread(review.reviewId, {
      sourceId: review.sources[1]!.id,
      path: 'config.json',
      line: 2,
      side: 'new',
      body: 'I turned debug on to match the ticket, worth a check',
    })

    // The reviewer's comment is a draft, so only the agent's own is visible.
    expect(await client.listThreads(review.reviewId)).toHaveLength(1)
    expect(await client.listThreads(review.reviewId, { drafts: true })).toHaveLength(2)

    const gateBefore = await client.gate(repoA.root, await fingerprint(repoA.root))
    expect(gateBefore.decision).toBe('deny')

    await reviewerSubmits(review.reviewId, 'changes_requested')

    const owed = await client.listThreads(review.reviewId, { turn: 'agent' })
    expect(owed).toHaveLength(1)
    expect(owed[0]?.messages[0]?.body).toBe('why 99?')

    await client.reply(owed[0]!.id, 'the ticket asked for 99')
    expect(await client.listThreads(review.reviewId, { turn: 'agent' })).toHaveLength(0)

    await reviewerSubmits(review.reviewId, 'approved')

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
    await reviewerSubmits(review.reviewId, 'approved')

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

    await reviewerSubmits(first.reviewId, 'approved')

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
      await reviewerComments(review.reviewId, {
        sourceId: review.sources[0]!.id,
        path: 'src/app.ts',
        line,
        body: `comment on line ${line}`,
      })
    }

    const waiting = client.wait(review.reviewId, 3000, Date.now())
    await new Promise((r) => setTimeout(r, 20))
    await reviewerSubmits(review.reviewId, 'changes_requested')

    const woke = await waiting
    expect(woke.wokeOn).toBe('submission')
    expect(woke.verdict).toBe('changes_requested')
    expect(woke.threadsAwaitingAgent).toBe(3)
  })
})

/**
 * Push gating, from the repository to the verdict.
 *
 * The unit tests each cover one seam: the range diff knows which commits are
 * unpushed, the daemon knows what a root gates on, and the hook knows which
 * verbs a command carries. None of them answers the question the feature rests
 * on, which is whether the fingerprint the reviewer approved is the one the
 * gate later asks about. Nothing but the whole loop can say that.
 */

/**
 * Fixing a comment, and the boundary that stops it.
 *
 * The page hides the controls once a comment is sent, and a hidden control is
 * not a refusal: anyone can post the form again. What makes sent immutable is
 * the route saying no.
 */
describe('editing a comment before it is sent', () => {
  async function draftOn(reviewId: string, sourceId: string): Promise<string> {
    await reviewerComments(reviewId, { sourceId, path: 'src/app.ts', line: 2, body: 'first go' })

    const threads = await client.listThreads(reviewId, { drafts: true })
    const message = threads[0]!.messages[0]!

    return message.id
  }

  it('rewrites a draft, and the new text is what a verdict sends', async () => {
    repoA.write('src/app.ts', 'const a = 1\nconst b = 99\nconst c = 3\n')

    const review = await client.createReview({
      title: 'a change to comment on',
      sources: [{ path: repoA.root, base: 'HEAD' }],
      createdBy: 'e2e',
      notify: false,
    })
    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repoA.root, baseRef: 'HEAD' },
    ])

    const messageId = await draftOn(review.reviewId, review.sources[0]!.id)

    const edited = await form(`/r/${review.reviewId}/messages/${messageId}`, {
      token: await pageToken(review.reviewId),
      body: 'second go, and this is the one that should travel',
    })
    expect(edited.status).toBe(303)

    await reviewerSubmits(review.reviewId, 'comment')

    const [thread] = await client.listThreads(review.reviewId)
    expect(thread!.messages[0]!.body).toContain('second go')
    expect(thread!.messages[0]!.body).not.toContain('first go')
  })

  it('refuses to rewrite one the agent has read, and says why', async () => {
    repoA.write('src/app.ts', 'const a = 1\nconst b = 99\nconst c = 3\n')

    const review = await client.createReview({
      title: 'a change to comment on',
      sources: [{ path: repoA.root, base: 'HEAD' }],
      createdBy: 'e2e',
      notify: false,
    })
    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repoA.root, baseRef: 'HEAD' },
    ])

    const messageId = await draftOn(review.reviewId, review.sources[0]!.id)
    await reviewerSubmits(review.reviewId, 'comment')

    const refused = await form(`/r/${review.reviewId}/messages/${messageId}`, {
      token: await pageToken(review.reviewId),
      body: 'too late',
    })

    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('has been sent')

    const [thread] = await client.listThreads(review.reviewId)
    expect(thread!.messages[0]!.body).toContain('first go')
  })

  // A thread with no messages would render as an empty box anchored to a line,
  // which is not what deleting your only comment means.
  it('takes the thread with the last comment in it', async () => {
    repoA.write('src/app.ts', 'const a = 1\nconst b = 99\nconst c = 3\n')

    const review = await client.createReview({
      title: 'a change to comment on',
      sources: [{ path: repoA.root, base: 'HEAD' }],
      createdBy: 'e2e',
      notify: false,
    })
    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repoA.root, baseRef: 'HEAD' },
    ])

    const messageId = await draftOn(review.reviewId, review.sources[0]!.id)

    const deleted = await form(`/r/${review.reviewId}/messages/${messageId}/delete`, {
      token: await pageToken(review.reviewId),
    })
    expect(deleted.status).toBe(303)

    expect(await client.listThreads(review.reviewId, { drafts: true })).toHaveLength(0)
  })
})

describe('gating a push rather than every commit', () => {
  /** A daemon that holds pushes for one repository and commits for the rest. */
  function daemonGating(root: string): Client {
    const config = resolve(
      configSchema.parse({
        public_url: 'https://mac.tailnet-name.ts.net',
        gate: { scope: 'commit', roots: { [root]: 'push' } },
      }),
      { configPath: '/tmp/reviewd-e2e.json', bindPublic: false },
    )

    const gating = createApp({ config, db: ctx.db, local: true })

    return new Client('http://127.0.0.1:7777', (input, init) =>
      gating.request(String(input).replace('http://127.0.0.1:7777', ''), {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), host: '127.0.0.1:7777' },
      }),
    )
  }

  /** Marks everything up to HEAD as already on a remote. */
  function published(repo: TempRepo): void {
    repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD')
  }

  it('reports what each repository holds', async () => {
    const gating = daemonGating(repoA.root)

    expect(await gating.gateScope(repoA.root)).toBe('push')
    expect(await gating.gateScope(repoB.root)).toBe('commit')
  })

  it('denies a push nobody has read, then allows the one they approved', async () => {
    const gating = daemonGating(repoA.root)
    published(repoA)

    repoA.write('src/app.ts', 'const a = 1\nconst b = 99\nconst c = 3\n')
    repoA.commit('bump b')
    repoA.write('src/app.ts', 'const a = 1\nconst b = 99\nconst c = 300\n')
    repoA.commit('bump c too')

    const range = (await pushRange(repoA.root))!
    expect(range.commits).toHaveLength(2)

    // The review comes first, because the manifest names the source id the
    // daemon assigned and a change set built without one is rejected.
    const review = await gating.createReview({
      title: 'two commits about to leave',
      sources: [{ path: repoA.root, base: range.base }],
      createdBy: 'e2e',
      notify: false,
    })

    const reading = await diffCommitRange(
      { id: review.sources[0]!.id, rootPath: repoA.root },
      range,
    )

    // Nobody has looked at it yet.
    const before = await gating.gate(repoA.root, reading.fingerprint)
    expect(before.decision).toBe('deny')
    expect(before.scope).toBe('push')

    for (const [id, bytes] of reading.blobs) await gating.putBlob(id, bytes)
    await gating.snapshot(review.reviewId, { files: reading.files })
    await reviewerSubmits(review.reviewId, 'approved')

    // The question the whole feature rests on: the fingerprint the reviewer
    // approved is the one the gate is asked about.
    const after = await gating.gate(repoA.root, reading.fingerprint)
    expect(after.decision).toBe('allow')
  })

  // An edit on disk is not being pushed, so it cannot move the verdict on the
  // commits that are.
  it('holds its approval across an uncommitted edit', async () => {
    published(repoA)

    repoA.write('src/app.ts', 'const a = 1\nconst b = 99\nconst c = 3\n')
    repoA.commit('bump b')

    const range = (await pushRange(repoA.root))!
    const before = await diffCommitRange({ id: '', rootPath: repoA.root }, range)

    repoA.write('src/app.ts', 'const a = 1\nconst b = 99\nconst c = 3\nconst d = 4\n')

    const after = await diffCommitRange(
      { id: '', rootPath: repoA.root },
      (await pushRange(repoA.root))!,
    )

    expect(after.fingerprint).toBe(before.fingerprint)
  })
})
