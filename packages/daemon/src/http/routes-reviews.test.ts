import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from '../config.js'
import { tempDatabase, type TempDatabase } from '../db/testing.js'
import { sha256 } from '../reviews.js'
import { createApp, type App } from './app.js'

let ctx: TempDatabase
let app: App

const JSON_POST = {
  'content-type': 'application/json',
  host: '127.0.0.1:7777',
}

beforeEach(async () => {
  ctx = await tempDatabase()
  const config = resolve(configSchema.parse({ public_url: 'https://mac.tailnet-name.ts.net' }), {
    configPath: '/tmp/reviewd-test.json',
    bindPublic: false,
  })
  app = createApp({ config, db: ctx.db, local: true })
})

afterEach(async () => {
  await ctx.close()
})

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: JSON_POST,
    body: JSON.stringify(body),
  })
}

describe('the push round trip', () => {
  it('creates a review, uploads only missing bytes, and takes a snapshot', async () => {
    const created = await post('/api/reviews', {
      title: 'two roots',
      sources: [
        { path: '/tmp/dotfiles', base: 'HEAD' },
        { path: '/tmp/claude', base: 'HEAD' },
      ],
      createdBy: 'session-a',
    })

    expect(created.status).toBe(201)
    const review = (await created.json()) as {
      reviewId: string
      url: string
      sources: { id: string }[]
    }
    expect(review.url).toBe(`https://mac.tailnet-name.ts.net/r/${review.reviewId}`)

    const content = new TextEncoder().encode('export const x = 1\n')
    const blobId = sha256(content)

    const check = await post(`/api/reviews/${review.reviewId}/blobs/check`, { ids: [blobId] })
    expect(await check.json()).toEqual({ missing: [blobId] })

    const upload = await app.request(`/api/blobs/${blobId}`, {
      method: 'PUT',
      headers: { host: '127.0.0.1:7777', 'content-type': 'application/octet-stream' },
      body: content,
    })
    expect(upload.status).toBe(201)

    // The second round asks again, and this time uploads nothing.
    const recheck = await post(`/api/reviews/${review.reviewId}/blobs/check`, { ids: [blobId] })
    expect(await recheck.json()).toEqual({ missing: [] })

    const snapshot = await post(`/api/reviews/${review.reviewId}/snapshots`, {
      fingerprints: {
        [review.sources[0]!.id]: 'fp-dotfiles',
        [review.sources[1]!.id]: 'fp-claude',
      },
      files: [
        {
          sourceId: review.sources[0]!.id,
          path: 'src/a.ts',
          changeType: 'added',
          newBlobId: blobId,
        },
      ],
    })

    expect(snapshot.status).toBe(201)
    expect(await snapshot.json()).toMatchObject({ seq: 1, filesChanged: 1 })

    const fetched = await app.request(`/api/reviews/${review.reviewId}`, {
      headers: { host: '127.0.0.1:7777' },
    })
    expect(await fetched.json()).toMatchObject({ snapshotSeq: 1, filesChanged: 1 })
  })

  it('serves stored bytes back unchanged', async () => {
    const content = new Uint8Array([0x00, 0xff, 0x10, 0x0a])
    const blobId = sha256(content)

    await app.request(`/api/blobs/${blobId}`, {
      method: 'PUT',
      headers: { host: '127.0.0.1:7777' },
      body: content,
    })

    const res = await app.request(`/api/blobs/${blobId}`, { headers: { host: '127.0.0.1:7777' } })
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(content)
  })
})

describe('errors', () => {
  it('names the offending field on a malformed review', async () => {
    const res = await post('/api/reviews', { title: '', sources: [] })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/title|sources/) })
  })

  it('reports 404 for a review nobody created', async () => {
    const res = await app.request('/api/reviews/nope', { headers: { host: '127.0.0.1:7777' } })
    expect(res.status).toBe(404)
  })

  it('reports 400 when uploaded bytes do not match their id', async () => {
    const res = await app.request(`/api/blobs/${sha256(new TextEncoder().encode('one'))}`, {
      method: 'PUT',
      headers: { host: '127.0.0.1:7777' },
      body: new TextEncoder().encode('two'),
    })

    expect(res.status).toBe(400)
  })

  it('refuses a snapshot POST that a third-party page started', async () => {
    const res = await app.request('/api/reviews/whatever/snapshots', {
      method: 'POST',
      headers: { ...JSON_POST, 'sec-fetch-site': 'cross-site' },
      body: '{}',
    })

    expect(res.status).toBe(403)
  })
})
