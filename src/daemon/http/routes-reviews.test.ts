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
    expect(await snapshot.json()).toMatchObject({ seq: 1, fileCount: 1 })

    const fetched = await app.request(`/api/reviews/${review.reviewId}`, {
      headers: { host: '127.0.0.1:7777' },
    })
    expect(await fetched.json()).toMatchObject({ snapshotSeq: 1, fileCount: 1 })
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

describe('the blob size limit', () => {
  /** A daemon that will not hold more than four bytes, so the limit is easy to cross. */
  function stingy(): App {
    const config = resolve(configSchema.parse({ limits: { max_blob_bytes: 4 } }), {
      configPath: '/tmp/reviewd-test.json',
      bindPublic: false,
    })
    return createApp({ config, db: ctx.db, local: true })
  }

  it('refuses on the declared length alone, before any of the body is read', async () => {
    // The body here would have been fine — two bytes, hashing to the id it was
    // filed under — so the only thing that can produce a 413 is the header. A
    // daemon that decided after reading would have stored it, which is the
    // whole failure: this route takes no token, so on a public bind a limit
    // enforced after the fact has already cost the memory it was guarding.
    const content = new TextEncoder().encode('ok')
    const res = await stingy().request(`/api/blobs/${sha256(content)}`, {
      method: 'PUT',
      headers: { host: '127.0.0.1:7777', 'content-length': '99999999' },
      body: content,
    })

    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('over the 4 limit') })
  })

  it('still refuses one that declared no length, having measured the bytes', async () => {
    const content = new TextEncoder().encode('far too much')
    const res = await stingy().request(`/api/blobs/${sha256(content)}`, {
      method: 'PUT',
      headers: { host: '127.0.0.1:7777' },
      body: content,
    })

    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('over the 4 limit') })
  })

  it('lets a blob inside the limit through', async () => {
    const content = new TextEncoder().encode('ok')
    const res = await stingy().request(`/api/blobs/${sha256(content)}`, {
      method: 'PUT',
      headers: { host: '127.0.0.1:7777', 'content-length': String(content.byteLength) },
      body: content,
    })

    expect(res.status).toBe(201)
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

  it('reports 400, not 500, when the body is not JSON at all', async () => {
    // Unguarded, `{oops` throws out of the route and comes back a 500 quoting
    // the JSON parser. It is an invalid request like any other.
    const res = await app.request('/api/reviews', {
      method: 'POST',
      headers: JSON_POST,
      body: '{oops',
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
