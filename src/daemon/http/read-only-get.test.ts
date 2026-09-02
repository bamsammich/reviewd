import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import { configSchema, resolve } from '../config.js'
import { tempDatabase, type TempDatabase } from '../db/testing.js'
import type { Database } from '../db/types.js'
import { createReview, createSnapshot, putBlob, sha256, type Deps } from '../reviews.js'
import { createThread } from '../threads.js'
import { createApp, type App } from './app.js'

/**
 * A GET must never change anything.
 *
 * The failure this guards against looks like an image tag in an email approving
 * a review, so it is worth stating as a rule rather than leaving to discipline.
 *
 * It was once a middleware watching for a header handlers were supposed to set
 * on themselves. Nothing ever set it, so the check passed by never firing and
 * read as a guarantee it was not making. Replacing that with a plugin that
 * counted queries worked, but it put machinery in the path of every request to
 * catch a mistake nobody had made yet. This is the same guarantee: it reads the
 * database before and after every GET the app serves, and the routes stay plain.
 *
 * The one write a GET is allowed is `last_activity_at`, which opening a review
 * stamps so the sweep can tell a review someone is using from one nobody came
 * back to. It carries no reviewer decision, and it is named here rather than
 * left to be discovered.
 */

let ctx: TempDatabase
let app: App
let deps: Deps
let reviewId: string
let blobId: string

const HOST = { host: '127.0.0.1:7777' }

/** Every row in the database, as one comparable value. */
async function snapshotOf(db: Kysely<Database>): Promise<string> {
  const tables = [
    'review',
    'source',
    'snapshot',
    'snapshot_source',
    'file_change',
    'thread',
    'message',
    'approval',
    'blob',
  ] as const

  const dump: Record<string, unknown[]> = {}

  for (const table of tables) {
    const rows = await db.selectFrom(table).selectAll().execute()

    // The activity stamp is the documented exception, so it is dropped rather
    // than allowed to make every read look like a write.
    dump[table] = rows.map((row) => {
      const copy = { ...(row as Record<string, unknown>) }
      if (table === 'review') delete copy['last_activity_at']
      return copy
    })
  }

  return JSON.stringify(dump)
}

beforeEach(async () => {
  ctx = await tempDatabase()
  const config = resolve(configSchema.parse({}), {
    configPath: '/tmp/reviewd-readonly.json',
    bindPublic: false,
  })
  deps = { db: ctx.db, config }
  app = createApp({ config, db: ctx.db, local: true })

  const review = await createReview(deps, {
    title: 'a review to read',
    sources: [{ path: '/tmp/repo', base: 'HEAD', includeUntracked: true }],
    createdBy: 'test',
    notify: false,
  })
  reviewId = review.reviewId

  const content = new TextEncoder().encode('const a = 1\n')
  blobId = sha256(content)
  await putBlob(deps, blobId, content)

  await createSnapshot(deps, reviewId, {
    files: [
      {
        sourceId: review.sources[0]!.id,
        path: 'src/a.ts',
        changeType: 'modified',
        oldPath: null,
        oldBlobId: null,
        newBlobId: blobId,
        oldHash: null,
        newHash: blobId,
        isBinary: false,
        truncated: false,
      },
    ],
  })

  // A thread, so the pages and the thread routes have something to render.
  await createThread(deps, reviewId, {
    sourceId: review.sources[0]!.id,
    path: 'src/a.ts',
    line: 1,
    side: 'new',
    body: 'a comment to read back',
    author: 'human',
  })
})

afterEach(async () => {
  await ctx.close()
})

/**
 * Fills a registered route pattern with values this fixture holds.
 *
 * Returning null for a pattern nothing can fill is deliberate: the test below
 * fails on it rather than skipping, so a new GET route with an unfamiliar
 * parameter has to be considered here instead of quietly escaping the sweep.
 */
function fill(path: string): string | null {
  const filled = path.replaceAll(':id', reviewId).replaceAll(':threadId', 'no-such-thread')

  return filled.includes(':') ? null : filled
}

describe('no GET changes review state', () => {
  it('leaves the database alone across every GET route the app serves', async () => {
    // Read from the app's own router, so a route added later is covered without
    // anyone remembering to list it here.
    const routes = [...new Set(app.routes.filter((r) => r.method === 'GET').map((r) => r.path))]

    expect(routes.length).toBeGreaterThan(4)

    const before = await snapshotOf(ctx.db)
    const unfillable: string[] = []

    for (const route of routes) {
      // The long poll blocks by design; asking it to wait for nothing is enough
      // to prove it writes nothing.
      const path = fill(route)
      if (path === null) {
        unfillable.push(route)
        continue
      }

      const url = route.endsWith('/wait') ? `${path}?timeout_ms=1` : path
      await app.request(url, { headers: HOST })
    }

    expect(unfillable, 'GET routes this test could not exercise').toEqual([])
    expect(await snapshotOf(ctx.db)).toBe(before)
  })

  it('reads a blob back without touching anything', async () => {
    const before = await snapshotOf(ctx.db)

    const res = await app.request(`/api/blobs/${blobId}`, { headers: HOST })

    expect(res.status).toBe(200)
    expect(await snapshotOf(ctx.db)).toBe(before)
  })

  it('still stamps activity when a review is opened, which is the one exception', async () => {
    await ctx.db
      .updateTable('review')
      .set({ last_activity_at: 0 })
      .where('id', '=', reviewId)
      .execute()

    await app.request(`/r/${reviewId}`, { headers: HOST })

    const row = await ctx.db
      .selectFrom('review')
      .select('last_activity_at')
      .where('id', '=', reviewId)
      .executeTakeFirstOrThrow()

    expect(row.last_activity_at).toBeGreaterThan(0)
  })
})

describe('the page script survives being embedded', () => {
  it('parses as JavaScript', async () => {
    // A stray backtick in a comment closes the template literal the script is
    // written in. TypeScript catches that only sometimes, and when it does not
    // the page ships a broken script: live updates stop, the comment box falls
    // back to a page load, and nothing anywhere reports an error.
    const html = await (await app.request(`/r/${reviewId}`, { headers: HOST })).text()
    const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''

    expect(script.length).toBeGreaterThan(500)
    expect(() => new Function(script)).not.toThrow()
  })

  it('closes its own script tag, so nothing after it is swallowed', async () => {
    const html = await (await app.request(`/r/${reviewId}`, { headers: HOST })).text()

    expect((html.match(/<script/g) ?? []).length).toBe((html.match(/<\/script>/g) ?? []).length)
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })
})

describe('a live refresh updates everything that can go stale', () => {
  it('replaces the header, where the revision label lives', async () => {
    // The label sits outside <main>, so a refresh that only swapped main left
    // the page showing a revision number it was no longer displaying — the one
    // part of the screen a reviewer checks to know what they are approving.
    const html = await (await app.request(`/r/${reviewId}`, { headers: HOST })).text()
    const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''

    expect(html).toContain('<header class="top">')
    expect(html).toMatch(/<header class="top">[\s\S]*?class="rev"/)
    expect(script, 'refresh() never replaces the header').toContain('header.top')
  })

  it('measures the bar rather than guessing its height', async () => {
    const html = await (await app.request(`/r/${reviewId}`, { headers: HOST })).text()
    const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''

    expect(script).toContain('--bar-height')
    expect(script).toContain('measureBar')
  })

  it('keeps the notice above the bar rather than behind it', async () => {
    const html = await (await app.request(`/r/${reviewId}`, { headers: HOST })).text()
    const style = /<style[^>]*>([\s\S]*?)<\/style>/g

    const css = [...html.matchAll(style)].map((m) => m[1]).join('\n')
    const notice = /\.live-notice\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const bar = /\.bar\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''

    const zOf = (block: string): number => Number(/z-index:\s*(\d+)/.exec(block)?.[1] ?? 0)

    expect(zOf(notice)).toBeGreaterThan(zOf(bar))
  })
})

describe('what may be served from a cache', () => {
  it('refuses to let the review page be cached', async () => {
    // A cached page redraws the code, the revision label, and the token as they
    // were, which is the failure the live refresh exists to prevent arriving by
    // a route the daemon never sees.
    for (const path of ['/', `/r/${reviewId}`]) {
      const res = await app.request(path, { headers: HOST })
      expect(res.headers.get('cache-control'), path).toBe('no-store')
    }
  })

  it('lets a blob be cached forever, since its address is its hash', async () => {
    const res = await app.request(`/api/blobs/${blobId}`, { headers: HOST })

    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(res.headers.get('content-disposition')).toBe('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('keeps API answers out of caches too', async () => {
    const res = await app.request(`/api/reviews/${reviewId}`, { headers: HOST })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

/**
 * Two display preferences arriving on one link.
 *
 * Each used to redirect on its own, which was fine while every control carried
 * one of them. Moving the diff controls apart gave each link the other's
 * value to preserve, and the first won: the drawer's own reopen link set the
 * view and dropped the rail, so the drawer could not be reopened at all.
 */
describe('display preferences on one link', () => {
  it('keeps both when a link carries both', async () => {
    const response = await app.request(`/r/${reviewId}?rail=closed&view=unified`, {
      headers: HOST,
    })
    const cookies = response.headers.getSetCookie().join(' ')

    expect(response.status).toBe(303)
    expect(cookies).toContain('reviewd_rail=closed')
    expect(cookies).toContain('reviewd_view=unified')
  })

  it('still keeps one when a link carries one', async () => {
    const response = await app.request(`/r/${reviewId}?rail=closed`, { headers: HOST })

    expect(response.status).toBe(303)
    expect(response.headers.getSetCookie().join(' ')).toContain('reviewd_rail=closed')
  })
})
