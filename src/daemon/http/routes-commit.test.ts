import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bus } from '../bus.js'
import { configSchema, resolve } from '../config.js'
import { tempDatabase, type TempDatabase } from '../db/testing.js'
import { createReview, createSnapshot, putBlob, sha256, type Deps } from '../reviews.js'
import { createApp, type App } from './app.js'

/**
 * Choosing a commit from the URL.
 *
 * Which commit is being read is what the page is about rather than how it is
 * drawn, so it travels in the address where a link can carry it, unlike the
 * split-view and drawer preferences that live in cookies.
 */

let ctx: TempDatabase
let deps: Deps
let app: App

const HOST = { host: '127.0.0.1:7777' }

beforeEach(async () => {
  ctx = await tempDatabase()
  const config = resolve(configSchema.parse({}), {
    configPath: '/tmp/reviewd-test.json',
    bindPublic: false,
  })
  deps = { db: ctx.db, config, bus: new Bus() }
  app = createApp({ config, db: ctx.db, local: true, bus: deps.bus as Bus })
})

afterEach(async () => {
  await ctx.close()
})

async function upload(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const id = sha256(bytes)
  await putBlob(deps, id, bytes)
  return id
}

function change(sourceId: string, path: string, blobId: string) {
  return {
    sourceId,
    path,
    changeType: 'modified' as const,
    oldPath: null,
    oldBlobId: null,
    newBlobId: blobId,
    oldHash: null,
    newHash: blobId,
    isBinary: false,
    truncated: false,
  }
}

/**
 * A push of two commits taking one file from 1 to 2 to 3, plus a second file
 * only the later commit touched.
 *
 * The interesting state is the 2: it is what the first commit left behind and
 * appears in no combined diff, which is the reason per-commit rows exist.
 */
async function pushOfTwoCommits() {
  const review = await createReview(deps, {
    title: 'a push',
    sources: [{ path: '/tmp/repo', base: 'HEAD', includeUntracked: true }],
    createdBy: 'test',
    notify: false,
  })

  const source = review.sources[0]!.id
  const two = await upload('const a = 2\n')
  const three = await upload('const a = 3\n')
  const other = await upload('const b = 1\n')

  await createSnapshot(deps, review.reviewId, {
    files: [change(source, 'src/a.ts', three), change(source, 'src/b.ts', other)],
    commits: [
      {
        sourceId: source,
        sha: 'aaaaaaa1111',
        subject: 'to two',
        author: 'test',
        committedAt: 1_700_000_000_000,
        files: [change(source, 'src/a.ts', two)],
      },
      {
        sourceId: source,
        sha: 'bbbbbbb2222',
        subject: 'to three and add b',
        author: 'test',
        committedAt: 1_700_000_060_000,
        files: [change(source, 'src/a.ts', three), change(source, 'src/b.ts', other)],
      },
    ],
  })

  return review
}

const read = async (path: string) => (await app.request(path, { headers: HOST })).text()

/**
 * The page without its markup.
 *
 * Highlighted code is a run of spans, so a line never appears in the HTML as
 * the string a person would search for.
 */
const plain = (html: string) => html.replace(/<[^>]*>/g, '')

describe('reading one commit from the URL', () => {
  it('shows the whole change when nothing is asked for', async () => {
    const review = await pushOfTwoCommits()
    const html = await read(`/r/${review.reviewId}`)

    expect(plain(html)).toContain('const a = 3')
    expect(plain(html)).not.toContain('const a = 2')
    expect(html).not.toContain('<div class="readingcommit">')
  })

  it('shows the state a later commit replaced', async () => {
    // The whole point: 2 is in no combined diff, so this is the only view that
    // can show it.
    const review = await pushOfTwoCommits()
    const html = await read(`/r/${review.reviewId}?commit=aaaaaaa1111`)

    expect(plain(html)).toContain('const a = 2')
    expect(html).toContain('<div class="readingcommit">')
    expect(html).toContain('to two')
  })

  it('scopes the file list to what that commit touched', async () => {
    const review = await pushOfTwoCommits()
    const first = await read(`/r/${review.reviewId}?commit=aaaaaaa1111`)

    // src/b.ts belongs to the second commit and to the combined change set.
    expect(first).toContain('src/a.ts')
    expect(first).not.toContain('src/b.ts')
  })

  it('falls back to the whole change when the sha names nothing', async () => {
    // A stale link after a rebase, which is the ordinary way this happens.
    const review = await pushOfTwoCommits()
    const html = await read(`/r/${review.reviewId}?commit=deadbee`)

    expect(plain(html)).toContain('const a = 3')
    expect(html).not.toContain('<div class="readingcommit">')
  })

  it('keeps the commit when a display preference is chosen', async () => {
    const review = await pushOfTwoCommits()
    const response = await app.request(`/r/${review.reviewId}?commit=aaaaaaa1111&view=unified`, {
      headers: HOST,
    })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`/r/${review.reviewId}?commit=aaaaaaa1111`)
  })

  it('says nothing about commits on a review that has none', async () => {
    const review = await createReview(deps, {
      title: 'a working tree',
      sources: [{ path: '/tmp/repo', base: 'HEAD', includeUntracked: true }],
      createdBy: 'test',
      notify: false,
    })

    const source = review.sources[0]!.id
    await createSnapshot(deps, review.reviewId, {
      files: [change(source, 'src/a.ts', await upload('const a = 1\n'))],
    })

    const html = await read(`/r/${review.reviewId}`)

    expect(html).toContain('src/a.ts')
    expect(html).not.toContain('<details class="commits"')
  })
})
