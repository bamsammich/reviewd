import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bus } from '../bus.js'
import { configSchema, resolve } from '../config.js'
import { tempDatabase, type TempDatabase } from '../db/testing.js'
import { release } from '../gate.js'
import { createReview, createSnapshot, putBlob, sha256, type Deps } from '../reviews.js'
import { createThread } from '../threads.js'
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
    title: 'live',
    sources: [{ path: '/tmp/repo', base: 'HEAD', includeUntracked: true }],
    createdBy: 'test',
    notify: false,
  })

  const content = new TextEncoder().encode('a\nb\nc\n')
  const blobId = sha256(content)
  await putBlob(deps, blobId, content)

  await createSnapshot(deps, review.reviewId, {
    fingerprints: { [review.sources[0]!.id]: 'fp-1' },
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

/**
 * Opens the stream and reads one frame, or gives up.
 *
 * Every caller closes, because a test that leaves the daemon holding a stream
 * open is a test that hangs the run rather than failing it.
 */
async function listen(reviewId: string, query = 'since=0') {
  const controller = new AbortController()
  const response = await app.request(`/r/${reviewId}/events?${query}`, {
    headers: HOST,
    signal: controller.signal,
  })

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()

  return {
    response,
    async frame(ms = 500): Promise<string> {
      const timer = setTimeout(() => controller.abort(), ms)
      let buffer = ''

      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return buffer
          buffer += decoder.decode(value, { stream: true })
          if (buffer.includes('\n\n')) return buffer
        }
      } catch {
        return buffer
      } finally {
        clearTimeout(timer)
      }
    },
    close(): void {
      controller.abort()
    },
  }
}

const agentComment = (reviewId: string, body = 'flagging this') =>
  createThread(deps, reviewId, { path: 'src/a.ts', line: 2, side: 'new', body, author: 'agent' })

describe('the review page event stream', () => {
  it('serves an event stream', async () => {
    const review = await seed()
    const stream = await listen(review.reviewId)

    expect(stream.response.headers.get('content-type')).toContain('text/event-stream')
    stream.close()
  })

  it('wakes the page when the agent writes', async () => {
    const review = await seed()
    const stream = await listen(review.reviewId, `since=${Date.now()}`)

    // Park first, then write, which is the shape a live page actually sees.
    await new Promise((r) => setTimeout(r, 20))
    await agentComment(review.reviewId)

    expect(await stream.frame()).toContain('event: threads')
    stream.close()
  })

  // A page that connects after the write, or reconnects across a daemon
  // restart, would otherwise sit on a stale render until the next one.
  it('answers on connect for a write it missed', async () => {
    const review = await seed()
    await agentComment(review.reviewId)

    const stream = await listen(review.reviewId, 'since=0')

    expect(await stream.frame()).toContain('event: threads')
    stream.close()
  })

  it('stays quiet when the page has already seen that write', async () => {
    const review = await seed()
    await agentComment(review.reviewId)

    const stream = await listen(review.reviewId, `since=${Date.now() + 1000}`)

    expect(await stream.frame(120)).not.toContain('event: threads')
    stream.close()
  })

  it('stays quiet for a comment the reviewer wrote', async () => {
    const review = await seed()
    const stream = await listen(review.reviewId, `since=${Date.now()}`)

    await new Promise((r) => setTimeout(r, 20))
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 2,
      side: 'new',
      body: 'mine, and still a draft',
      author: 'human',
    })

    expect(await stream.frame(120)).not.toContain('event: threads')
    stream.close()
  })

  it('tells the page when the review is released out from under it', async () => {
    const review = await seed()
    const stream = await listen(review.reviewId, `since=${Date.now()}`)

    await new Promise((r) => setTimeout(r, 20))
    await release(deps, review.reviewId, true)

    expect(await stream.frame()).toContain('event: gone')
    stream.close()
  })
})
