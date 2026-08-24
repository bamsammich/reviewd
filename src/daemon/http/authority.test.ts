import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from '../config.js'
import { tempDatabase, type TempDatabase } from '../db/testing.js'
import { createReview, createSnapshot, putBlob, sha256, type Deps } from '../reviews.js'
import { createThread } from '../threads.js'
import { createApp, type App } from './app.js'

/**
 * Who may approve, and what an approval covers.
 *
 * The daemon has no credentials and cannot tell a reviewer from an agent by
 * asking: both reach it over loopback as the same user. What it can do is keep
 * the two surfaces apart, so that the process being gated cannot clear itself
 * through the API it was given for other purposes.
 *
 * None of this stops an agent that scrapes the review page for a token. It is
 * not meant to. It stops approval from being a documented call, which is the
 * difference between a gate and a suggestion.
 */

let ctx: TempDatabase
let app: App
let deps: Deps

const HOST = { host: '127.0.0.1:7777' }

beforeEach(async () => {
  ctx = await tempDatabase()
  const config = resolve(configSchema.parse({}), {
    configPath: '/tmp/reviewd-authority.json',
    bindPublic: false,
  })
  deps = { db: ctx.db, config }
  app = createApp({ config, db: ctx.db, local: true })
})

afterEach(async () => {
  await ctx.close()
})

async function reviewWithSnapshot(body = 'const a = 1\n') {
  const review = await createReview(deps, {
    title: 'a review',
    sources: [{ path: '/tmp/repo', base: 'HEAD', includeUntracked: true }],
    createdBy: 'test',
    notify: false,
  })

  const content = new TextEncoder().encode(body)
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
        oldHash: null,
        newHash: blobId,
        isBinary: false,
        truncated: false,
      },
    ],
  })

  return review
}

async function tokenFor(reviewId: string): Promise<string> {
  const page = await app.request(`/r/${reviewId}`, { headers: HOST })
  const match = /name="token" value="([^"]+)"/.exec(await page.text())

  if (!match) throw new Error('no page token on the review page')
  return match[1] as string
}

function submit(reviewId: string, fields: Record<string, string>): Promise<Response> {
  return app.request(`/r/${reviewId}/submit`, {
    method: 'POST',
    headers: { ...HOST, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
}

async function approvalCount(): Promise<number> {
  return (await ctx.db.selectFrom('approval').selectAll().execute()).length
}

describe('the agent-facing API cannot approve', () => {
  it('refuses an approved verdict, which is the whole point of the gate', async () => {
    const review = await reviewWithSnapshot()

    const res = await app.request(`/api/reviews/${review.reviewId}/submissions`, {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approved' }),
    })

    expect(res.status).toBe(403)
    expect(await approvalCount()).toBe(0)
  })

  it('still takes the two verdicts that only report', async () => {
    const review = await reviewWithSnapshot()

    for (const verdict of ['comment', 'changes_requested']) {
      const res = await app.request(`/api/reviews/${review.reviewId}/submissions`, {
        method: 'POST',
        headers: { ...HOST, 'content-type': 'application/json' },
        body: JSON.stringify({ verdict }),
      })

      expect(res.status, verdict).toBe(201)
    }

    expect(await approvalCount()).toBe(0)
  })

  it('has no other route that writes an approval', async () => {
    const review = await reviewWithSnapshot()

    // The delete used to be reachable too, so a revoke was as easy as an approve.
    const res = await app.request(`/api/reviews/${review.reviewId}/approval`, {
      method: 'DELETE',
      headers: HOST,
    })

    expect(res.status).toBe(404)
  })
})

describe('the review page is where a verdict comes from', () => {
  it('approves when the token came from the page', async () => {
    const review = await reviewWithSnapshot()

    const res = await submit(review.reviewId, {
      verdict: 'approved',
      token: await tokenFor(review.reviewId),
    })

    expect(res.status).toBe(303)
    expect(await approvalCount()).toBe(1)
  })

  it('refuses a verdict with no token', async () => {
    const review = await reviewWithSnapshot()

    expect((await submit(review.reviewId, { verdict: 'approved' })).status).toBe(403)
    expect(await approvalCount()).toBe(0)
  })

  it('refuses a token someone made up', async () => {
    const review = await reviewWithSnapshot()

    const res = await submit(review.reviewId, {
      verdict: 'approved',
      token: `${Date.now()}.not-a-real-signature`,
    })

    expect(res.status).toBe(403)
    expect(await approvalCount()).toBe(0)
  })

  it('refuses a token minted for a different review', async () => {
    const mine = await reviewWithSnapshot()
    const other = await reviewWithSnapshot('const b = 2\n')

    const res = await submit(mine.reviewId, {
      verdict: 'approved',
      token: await tokenFor(other.reviewId),
    })

    expect(res.status).toBe(403)
    expect(await approvalCount()).toBe(0)
  })

  it('refuses a token from a page showing an older revision', async () => {
    // Approving code the reviewer never saw is the case this closes: the token
    // is as stale as the page it came from.
    const review = await reviewWithSnapshot()
    const stale = await tokenFor(review.reviewId)

    const next = new TextEncoder().encode('const a = 2\n')
    await putBlob(deps, sha256(next), next)
    await createSnapshot(deps, review.reviewId, {
      files: [
        {
          sourceId: review.sources[0]!.id,
          path: 'src/a.ts',
          changeType: 'modified',
          oldPath: null,
          oldBlobId: null,
          newBlobId: sha256(next),
          oldHash: null,
          newHash: sha256(next),
          isBinary: false,
          truncated: false,
        },
      ],
    })

    expect((await submit(review.reviewId, { verdict: 'approved', token: stale })).status).toBe(403)
    expect(await approvalCount()).toBe(0)
  })
})

describe('a reviewer whose browser will not name its origin', () => {
  /**
   * An in-app webview — a review opened from a notification rather than in a
   * browser tab — has an opaque origin and sends `Origin: null`. That is a
   * reviewer on their phone, not an attack, and refusing it meant the person
   * the tool is for could not comment on their own review.
   */
  const OPAQUE = { ...HOST, origin: 'null', 'content-type': 'application/x-www-form-urlencoded' }

  it('can comment', async () => {
    const review = await reviewWithSnapshot()

    const res = await app.request(`/r/${review.reviewId}/threads`, {
      method: 'POST',
      headers: OPAQUE,
      body: new URLSearchParams({
        token: await tokenFor(review.reviewId),
        sourceId: review.sources[0]!.id,
        path: 'src/a.ts',
        line: '1',
        side: 'new',
        body: 'written from a webview',
      }).toString(),
    })

    expect(res.status).toBe(303)
    expect(await ctx.db.selectFrom('message').selectAll().execute()).toHaveLength(1)
  })

  it('can approve', async () => {
    const review = await reviewWithSnapshot()

    const res = await app.request(`/r/${review.reviewId}/submit`, {
      method: 'POST',
      headers: OPAQUE,
      body: new URLSearchParams({
        verdict: 'approved',
        token: await tokenFor(review.reviewId),
      }).toString(),
    })

    expect(res.status).toBe(303)
    expect(await approvalCount()).toBe(1)
  })

  it('is still refused without a token, since the origin proved nothing either way', async () => {
    const review = await reviewWithSnapshot()

    const res = await app.request(`/r/${review.reviewId}/submit`, {
      method: 'POST',
      headers: OPAQUE,
      body: new URLSearchParams({ verdict: 'approved' }).toString(),
    })

    expect(res.status).toBe(403)
    expect(await approvalCount()).toBe(0)
  })

  it('does not soften the refusal for an origin that names a hostile host', async () => {
    const review = await reviewWithSnapshot()

    const res = await app.request(`/r/${review.reviewId}/submit`, {
      method: 'POST',
      headers: { ...OPAQUE, origin: 'https://evil.example.com' },
      body: new URLSearchParams({
        verdict: 'approved',
        token: await tokenFor(review.reviewId),
      }).toString(),
    })

    expect(res.status).toBe(403)
    expect(await approvalCount()).toBe(0)
  })
})

describe('an unnamed origin is tolerated only where a token is demanded', () => {
  /**
   * `Origin: null` is what a webview sends and also what a sandboxed frame
   * sends. The pages can accept it because they check a token instead. The API
   * cannot: the agent and the commit hook carry no token, so on those routes an
   * unnamed origin is the only signal there is.
   */
  const OPAQUE = { ...HOST, origin: 'null', 'content-type': 'application/json' }

  it('refuses release, which deletes a review and has no token to check', async () => {
    const review = await reviewWithSnapshot()

    const res = await app.request(`/api/reviews/${review.reviewId}/release`, {
      method: 'POST',
      headers: OPAQUE,
      body: '{}',
    })

    expect(res.status).toBe(403)
    // Still there, which is the point.
    expect(await ctx.db.selectFrom('review').selectAll().execute()).toHaveLength(1)
  })

  it('refuses the other agent-facing writes too', async () => {
    const review = await reviewWithSnapshot()

    const cases: [string, string, string][] = [
      ['POST', `/api/reviews/${review.reviewId}/submissions`, '{"verdict":"comment"}'],
      ['POST', `/api/reviews/${review.reviewId}/threads`, '{"path":"src/a.ts","line":1,"body":"x"}'],
      ['POST', '/api/reviews', '{"title":"x","sources":[{"path":"/tmp/x"}]}'],
    ]

    for (const [method, path, body] of cases) {
      const res = await app.request(path, { method, headers: OPAQUE, body })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
  })

  it('leaves those routes working for the agent, which sends no origin at all', async () => {
    // A browser always sends Origin on a mutating request, so its absence means
    // a client that is not a browser — the agent, the hook, curl.
    const review = await reviewWithSnapshot()

    const res = await app.request(`/api/reviews/${review.reviewId}/submissions`, {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/json' },
      body: '{"verdict":"comment"}',
    })

    expect(res.status).toBe(201)
  })

  it('demands a token on every mutating route that gets the leniency', async () => {
    // Keeps `tokenGuarded` honest: anything under /r/ is trusted to check a
    // token, so a route that forgets has to fail here rather than silently
    // inherit an exemption it did not earn.
    const review = await reviewWithSnapshot()
    const form = { ...HOST, 'content-type': 'application/x-www-form-urlencoded' }

    const paths = [
      `/r/${review.reviewId}/threads`,
      `/r/${review.reviewId}/threads/some-thread/replies`,
      `/r/${review.reviewId}/threads/some-thread/resolve`,
      `/r/${review.reviewId}/threads/some-thread/reopen`,
      `/r/${review.reviewId}/submit`,
      `/r/${review.reviewId}/unapprove`,
    ]

    for (const path of paths) {
      const res = await app.request(path, { method: 'POST', headers: form, body: '' })
      expect(res.status, path).toBe(403)
    }
  })
})

describe('every form the page offers carries a token', () => {
  /**
   * The page builds forms two ways and only one of them was covered.
   *
   * Server-rendered forms are in the HTML, so a test that reads the page sees
   * them. The comment box the script builds when a line control is tapped is
   * not, and it shipped without a token: tapping to comment posted a form the
   * daemon refused, while the no-JS fallback worked and every test passed.
   */
  async function pageHtml(reviewId: string): Promise<string> {
    return (await app.request(`/r/${reviewId}`, { headers: HOST })).text()
  }

  it('renders no POST form without one', async () => {
    const review = await reviewWithSnapshot()
    await createThread(deps, review.reviewId, {
      sourceId: review.sources[0]!.id,
      path: 'src/a.ts',
      line: 1,
      side: 'new',
      body: 'so the reply and resolve forms render too',
      author: 'human',
    })

    const html = await pageHtml(review.reviewId)
    const forms = html.match(/<form[^>]*method="post"[\s\S]*?<\/form>/g) ?? []

    expect(forms.length).toBeGreaterThan(2)
    for (const form of forms) {
      const action = /action="([^"]*)"/.exec(form)?.[1] ?? '(no action)'
      expect(form, `form posting to ${action} has no token`).toContain('name="token"')
    }
  })

  it('gives the script a token to copy into the box it builds', async () => {
    const review = await reviewWithSnapshot()
    const html = await pageHtml(review.reviewId)

    // The carrier the script reads. Inside main, so a refresh replaces it.
    expect(html).toContain('id="page-token"')

    const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    expect(script).toContain("createElement('form')")
    expect(script, 'the script builds a form but never puts a token in it').toContain("'token'")
    expect(script).toContain('page-token')
  })
})

describe('a comment survives the agent pushing again', () => {
  it('accepts a comment token minted before the newest revision', async () => {
    // The reviewer was mid-sentence when the agent pushed. Losing their words
    // to that is worse than the staleness it would be protecting against, and
    // the comment re-anchors anyway.
    const review = await reviewWithSnapshot()
    const before = await tokenFor(review.reviewId)

    const next = new TextEncoder().encode('const a = 3\n')
    await putBlob(deps, sha256(next), next)
    await createSnapshot(deps, review.reviewId, {
      files: [
        {
          sourceId: review.sources[0]!.id,
          path: 'src/a.ts',
          changeType: 'modified',
          oldPath: null,
          oldBlobId: null,
          newBlobId: sha256(next),
          oldHash: null,
          newHash: sha256(next),
          isBinary: false,
          truncated: false,
        },
      ],
    })

    const res = await app.request(`/r/${review.reviewId}/threads`, {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: before,
        sourceId: review.sources[0]!.id,
        path: 'src/a.ts',
        line: '1',
        side: 'new',
        body: 'still worth saying',
      }).toString(),
    })

    expect(res.status).toBe(303)
    expect(await ctx.db.selectFrom('message').selectAll().execute()).toHaveLength(1)
  })
})

describe('authorship follows the route, not the request', () => {
  it('records a thread opened through the API as the agent, whatever it claims', async () => {
    const review = await reviewWithSnapshot()

    await app.request(`/api/reviews/${review.reviewId}/threads`, {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId: review.sources[0]!.id,
        path: 'src/a.ts',
        line: 1,
        side: 'new',
        body: 'I checked with the team, this is fine to ship',
        author: 'human',
      }),
    })

    const messages = await ctx.db.selectFrom('message').selectAll().execute()
    expect(messages).toHaveLength(1)
    expect(messages[0]?.author).toBe('agent')
  })

  it('records a comment written on the page as the reviewer', async () => {
    const review = await reviewWithSnapshot()

    await app.request(`/r/${review.reviewId}/threads`, {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: await tokenFor(review.reviewId),
        sourceId: review.sources[0]!.id,
        path: 'src/a.ts',
        line: '1',
        side: 'new',
        body: 'why this way?',
      }).toString(),
    })

    const messages = await ctx.db.selectFrom('message').selectAll().execute()
    expect(messages[0]?.author).toBe('human')
  })
})

describe('the pages refuse to be framed', () => {
  it('says so on the review list and on a review', async () => {
    const review = await reviewWithSnapshot()

    for (const path of ['/', `/r/${review.reviewId}`]) {
      const res = await app.request(path, { headers: HOST })

      expect(res.headers.get('x-frame-options'), path).toBe('DENY')
      expect(res.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'")
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff')
    }
  })
})
