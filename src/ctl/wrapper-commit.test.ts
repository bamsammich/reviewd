import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from '../daemon/config.js'
import { tempDatabase, type TempDatabase } from '../daemon/db/testing.js'
import { createApp, type App } from '../daemon/http/app.js'
import { Client } from './client.js'
import { diffSource } from './diff.js'
import { pushSnapshot } from './push.js'
import { tempRepo, type TempRepo } from './testing.js'

/**
 * A commit reached through something other than a command an agent typed.
 *
 * The gate is a `PreToolUse` hook, so it reads the text of the command. `npm
 * version patch` records its commit from inside npm's own process and is not
 * that text, and the same holds for `cargo release`, a Makefile target, or a
 * script written a moment earlier. Found while cutting 0.1.3 by running the
 * release command the README documents.
 *
 * Prevention cannot reach this. Nothing before the fact can see a commit a
 * wrapper has not made yet, and adding one more pattern to the hook catches
 * one wrapper and teaches nobody the general lesson. What can reach it is
 * `reviewd observe`, which reads what a commit recorded and compares it
 * against what an approval cleared. These are the tests for whether it does.
 */

let ctx: TempDatabase
let app: App
let repo: TempRepo

beforeEach(async () => {
  ctx = await tempDatabase()

  repo = tempRepo()
  repo.write('src/a.ts', 'const a = 1\n')
  repo.commit('initial')
})

afterEach(async () => {
  repo.cleanup()
  await ctx.close()
})

function daemon(): Client {
  const config = resolve(
    configSchema.parse({
      public_url: 'https://mac.tailnet-name.ts.net',
      gate: { scope: 'commit', roots: {} },
    }),
    { configPath: '/tmp/reviewd-wrapper.json', bindPublic: false },
  )

  app = createApp({ config, db: ctx.db, local: true })

  return new Client('http://127.0.0.1:7777', (input, init) =>
    app.request(String(input).replace('http://127.0.0.1:7777', ''), {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), host: '127.0.0.1:7777' },
    }),
  )
}

async function approve(reviewId: string): Promise<void> {
  const page = await app.request(`/r/${reviewId}`, { headers: { host: '127.0.0.1:7777' } })
  const match = /name="token" value="([^"]+)"/.exec(await page.text())
  if (!match) throw new Error('no page token on the review page')

  await app.request(`/r/${reviewId}/submit`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:7777',
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams({ verdict: 'approved', token: match[1] as string }).toString(),
  })
}

/** Opens a review of the working tree and has the reviewer approve it. */
async function reviewed(client: Client): Promise<void> {
  const review = await client.createReview({
    title: 'the change somebody read',
    sources: [{ path: repo.root, base: 'HEAD' }],
    createdBy: 'test',
    notify: false,
  })

  await pushSnapshot(client, review.reviewId, [{ id: review.sources[0]!.id, rootPath: repo.root }])

  await approve(review.reviewId)
}

/** The gate call the hook makes ahead of a command it recognised. */
async function gate(client: Client) {
  const reading = await diffSource({ id: '', rootPath: repo.root })
  const head = repo.run('rev-parse', 'HEAD').trim()

  return client.gate(repo.root, reading.fingerprint, reading.tree, head)
}

/** What `reviewd observe` asks about whatever HEAD now is. */
async function observe(client: Client) {
  const head = repo.run('rev-parse', 'HEAD').trim()
  const tree = repo.run('rev-parse', 'HEAD^{tree}').trim()

  return client.observe(repo.root, head, tree)
}

describe('a commit the gate cleared', () => {
  it('reads as clean afterwards', async () => {
    const client = daemon()

    repo.write('src/a.ts', 'const a = 2\n')
    await reviewed(client)

    expect((await gate(client)).decision).toBe('allow')
    repo.commit('the change that was read')

    const result = await observe(client)

    expect(result.finding).toBe('clean')
  })
})

describe('a commit no gate ever saw', () => {
  /**
   * `npm version patch` writes exactly this. The hook matched on the text of
   * the command, the text was `npm version patch`, and the record happened
   * inside npm's own child process.
   */
  it('is reported, because nothing checked it against a review', async () => {
    const client = daemon()

    repo.write('src/a.ts', 'const a = 2\n')
    await reviewed(client)

    // No gate call: the wrapper never went through the hook.
    repo.write('package.json', '{ "version": "0.1.4" }\n')
    repo.commit('0.1.4')

    const result = await observe(client)

    expect(result.finding).toBe('ungated')
    expect(result.reason).toContain('no approval was used')
  })

  it('is reported even after an earlier change went through the gate', async () => {
    const client = daemon()

    repo.write('src/a.ts', 'const a = 2\n')
    await reviewed(client)
    await gate(client)
    repo.commit('the change that was read')

    // The release command, run straight after, carrying content nobody read.
    repo.write('package.json', '{ "version": "0.1.4" }\n')
    repo.commit('0.1.4')

    const result = await observe(client)

    expect(result.finding).not.toBe('clean')
    expect(result.reason).toContain(repo.run('rev-parse', 'HEAD').trim().slice(0, 12))
  })

  /**
   * Where observation stops, pinned rather than fixed.
   *
   * Releasing deletes the review, and observe speaks only about a repository
   * some review covers, so a wrapper run after a release is unwatched. Cutting
   * 0.1.3 went exactly that way: approve, commit, release, `npm version
   * patch`, silence.
   *
   * Keeping a record of the approved tree past the release would close it and
   * cost more than it is worth: every later commit in that repository differs
   * from that tree, so the report would fire on ordinary work until the next
   * review opened, and an alarm that fires on ordinary work is one a reader
   * learns to dismiss. The skill releases last instead, and the README says
   * where the boundary is.
   */
  it('goes unreported once the review has been released', async () => {
    const client = daemon()

    repo.write('src/a.ts', 'const a = 2\n')

    const review = await client.createReview({
      title: 'the change somebody read',
      sources: [{ path: repo.root, base: 'HEAD' }],
      createdBy: 'test',
      notify: false,
    })
    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repo.root },
    ])
    await approve(review.reviewId)
    await gate(client)
    repo.commit('the change that was read')

    await client.release(review.reviewId)

    repo.write('package.json', '{ "version": "0.1.4" }\n')
    repo.commit('0.1.4')

    const result = await observe(client)

    expect(result.finding).toBe('clean')
    expect(result.reason).toContain('no review covers')
  })

  /**
   * A repository nobody is reviewing is not the gate's business, and saying so
   * on every command in every unrelated checkout would turn the hook into
   * noise nobody reads.
   */
  it('says nothing about a repository no review covers', async () => {
    const client = daemon()

    repo.write('package.json', '{ "version": "0.1.4" }\n')
    repo.commit('0.1.4')

    const result = await observe(client)

    expect(result.finding).toBe('clean')
    expect(result.reason).toContain('no review covers')
  })
})
