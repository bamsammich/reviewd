import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WaitResult } from '../../protocol.js'
import { Bus } from '../bus.js'
import { configSchema, resolve } from '../config.js'
import { tempDatabase, type TempDatabase } from '../db/testing.js'
import { createReview, createSnapshot, putBlob, sha256, type Deps } from '../reviews.js'
import { createThread, submitReview } from '../threads.js'
import { release } from '../gate.js'
import { createApp, type App } from './app.js'

let ctx: TempDatabase
let deps: Deps
let bus: Bus
let app: App

const HOST = { host: '127.0.0.1:7777' }

beforeEach(async () => {
  ctx = await tempDatabase()
  bus = new Bus()
  const config = resolve(configSchema.parse({}), {
    configPath: '/tmp/reviewd-test.json',
    bindPublic: false,
  })
  deps = { db: ctx.db, config, bus }
  app = createApp({ config, db: ctx.db, local: true, bus })
})

afterEach(async () => {
  await ctx.close()
})

async function seed() {
  const review = await createReview(deps, {
    title: 'waiting',
    sources: [{ path: '/tmp/repo', base: 'HEAD', includeUntracked: true }],
    createdBy: 'test',
    notify: false,
  })

  const content = new TextEncoder().encode('a\nb\nc\n')
  const blobId = sha256(content)
  await putBlob(deps, blobId, content)

  await createSnapshot(deps, review.reviewId, {
    files: [
      {
        sourceId: review.sources[0]!.id,
        path: 'src/a.ts',
        changeType: 'modified',
        oldPath: null,
        oldBlobId: null,
        newBlobId: blobId,
        isBinary: false,
        truncated: false,
      },
    ],
  })

  return review
}

function waitFor(reviewId: string, query = 'timeout_ms=2000&since=0'): Promise<Response> {
  return app.request(`/api/reviews/${reviewId}/wait?${query}`, { headers: HOST })
}

describe('wait', () => {
  it('is not woken by a revision the agent pushed itself', async () => {
    // Ending a wait with no verdict reads to the caller as approval it never
    // got, and a revision is the waiting agent's own doing.
    const review = await seed()
    const pending = waitFor(review.reviewId, 'timeout_ms=400&since=0')

    await new Promise((r) => setTimeout(r, 20))

    const content = new TextEncoder().encode('a\nb\nc\nd\n')
    await putBlob(deps, sha256(content), content)
    await createSnapshot(deps, review.reviewId, {
      files: [
        {
          sourceId: review.sources[0]!.id,
          path: 'src/a.ts',
          changeType: 'modified',
          oldPath: null,
          oldBlobId: null,
          newBlobId: sha256(content),
          oldHash: null,
          newHash: sha256(content),
          isBinary: false,
          truncated: false,
        },
      ],
    })

    expect((await (await pending).json()).wokeOn).toBe('timeout')
  })

  it('wakes on a submission that lands while it is parked', async () => {
    const review = await seed()
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 2,
      side: 'new',
      body: 'change this',
      author: 'human',
    })

    const pending = waitFor(review.reviewId)
    // Park first, then submit, which is the shape the agent actually runs in.
    await new Promise((r) => setTimeout(r, 20))
    await submitReview(deps, review.reviewId, 'changes_requested')

    const result = (await (await pending).json()) as WaitResult
    expect(result.wokeOn).toBe('submission')
    expect(result.verdict).toBe('changes_requested')
    expect(result.threadsAwaitingAgent).toBe(1)
  })

  // The review page listens on the same per-review channel, so the agent's own
  // comments now travel it. Waking here on one would end the wait carrying no
  // verdict, which the caller reads as an approval it never got.
  it('stays parked when the agent writes a comment of its own', async () => {
    const review = await seed()

    const pending = waitFor(review.reviewId, 'timeout_ms=300&since=0')
    await new Promise((r) => setTimeout(r, 20))
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 2,
      side: 'new',
      body: 'flagging a judgement call',
      author: 'agent',
    })

    const result = (await (await pending).json()) as WaitResult
    expect(result.wokeOn).toBe('timeout')
    expect(result.verdict).toBeNull()
  })

  it('still wakes on a submission that follows one of its own comments', async () => {
    const review = await seed()

    const pending = waitFor(review.reviewId)
    await new Promise((r) => setTimeout(r, 20))
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 2,
      side: 'new',
      body: 'flagging a judgement call',
      author: 'agent',
    })
    await new Promise((r) => setTimeout(r, 20))
    await submitReview(deps, review.reviewId, 'approved')

    const result = (await (await pending).json()) as WaitResult
    expect(result.wokeOn).toBe('submission')
    expect(result.verdict).toBe('approved')
  })

  it('answers immediately for a submission it has not seen', async () => {
    // Without this a submission landing between two waits would sit unnoticed,
    // which on a review that gets one submission is forever.
    const review = await seed()
    await submitReview(deps, review.reviewId, 'approved')

    const result = (await (await waitFor(review.reviewId)).json()) as WaitResult
    expect(result.wokeOn).toBe('submission')
    expect(result.verdict).toBe('approved')
  })

  it('parks again when the caller has already seen the last submission', async () => {
    const review = await seed()
    await submitReview(deps, review.reviewId, 'comment')

    const seen = Date.now() + 1000
    const result = (await (
      await waitFor(review.reviewId, `timeout_ms=60&since=${seen}`)
    ).json()) as WaitResult

    expect(result.wokeOn).toBe('timeout')
  })

  it('times out with the verdict left null', async () => {
    const review = await seed()

    const result = (await (
      await waitFor(review.reviewId, 'timeout_ms=60&since=0')
    ).json()) as WaitResult

    expect(result.wokeOn).toBe('timeout')
    expect(result.verdict).toBeNull()
  })

  it('reports a review released out from under it', async () => {
    const review = await seed()

    const pending = waitFor(review.reviewId)
    await new Promise((r) => setTimeout(r, 20))
    await release(deps, review.reviewId, true)

    const result = (await (await pending).json()) as WaitResult
    expect(result.wokeOn).toBe('released')
    expect(result.url).toBeNull()
  })

  it('reports released for a review that never existed', async () => {
    const result = (await (await waitFor('nope', 'timeout_ms=60&since=0')).json()) as WaitResult
    expect(result.wokeOn).toBe('released')
  })
})

describe('bus', () => {
  it('delivers one event per submission rather than one per comment', async () => {
    const review = await seed()
    const seen: string[] = []

    for (const body of ['one', 'two', 'three']) {
      await createThread(deps, review.reviewId, {
        path: 'src/a.ts',
        line: 1,
        side: 'new',
        body,
        author: 'human',
      })
    }

    const pending = bus.wait(review.reviewId, 2000)
    await new Promise((r) => setTimeout(r, 20))
    await submitReview(deps, review.reviewId, 'changes_requested')

    const event = await pending
    if (event) seen.push(event.kind)

    expect(seen).toEqual(['submission'])
  })

  it('resolves null when the caller aborts', async () => {
    const controller = new AbortController()
    const pending = bus.wait('any-review', 5000, controller.signal)

    controller.abort()
    expect(await pending).toBeNull()
  })
})
