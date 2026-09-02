import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from '../daemon/config.js'
import { tempDatabase, type TempDatabase } from '../daemon/db/testing.js'
import { createApp, type App } from '../daemon/http/app.js'
import { Client } from './client.js'
import { commitInfo, diffCommitRange, patchIds, pushRange } from './diff.js'
import { pushSnapshot } from './push.js'
import { tempRepo, type TempRepo } from './testing.js'

/**
 * Approving one commit of a push rather than all of them.
 *
 * The gate already asks about commits one at a time, so a reviewer who has
 * read three of five has said something the gate can act on. What was missing
 * is a way to say it: approving covered every commit the review listed, which
 * on a stack means approving work nobody had opened.
 */

let ctx: TempDatabase
let app: App
let repo: TempRepo

beforeEach(async () => {
  ctx = await tempDatabase()

  repo = tempRepo()
  repo.write('src/a.ts', 'const a = 1\n')
  repo.commit('already pushed')
  repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD')
})

afterEach(async () => {
  repo.cleanup()
  await ctx.close()
})

function daemon(): Client {
  const config = resolve(
    configSchema.parse({
      public_url: 'https://mac.tailnet-name.ts.net',
      gate: { scope: 'push', roots: {} },
    }),
    { configPath: '/tmp/reviewd-scoped-approve.json', bindPublic: false },
  )

  app = createApp({ config, db: ctx.db, local: true })

  return new Client('http://127.0.0.1:7777', (input, init) =>
    app.request(String(input).replace('http://127.0.0.1:7777', ''), {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), host: '127.0.0.1:7777' },
    }),
  )
}

/** A verdict as the page sends one, optionally about a single commit. */
async function submit(
  reviewId: string,
  verdict: string,
  commit?: string,
  path = 'submit',
): Promise<void> {
  const page = await app.request(`/r/${reviewId}`, { headers: { host: '127.0.0.1:7777' } })
  const match = /name="token" value="([^"]+)"/.exec(await page.text())
  if (!match) throw new Error('no page token on the review page')

  const body: Record<string, string> = { token: match[1] as string }
  if (verdict.length > 0) body['verdict'] = verdict
  if (commit !== undefined) body['commit'] = commit

  await app.request(`/r/${reviewId}/${path}`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:7777',
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams(body).toString(),
  })
}

async function open(client: Client) {
  const review = await client.createReview({
    title: 'a stack',
    sources: [{ path: repo.root, base: 'HEAD' }],
    createdBy: 'test',
    notify: false,
  })

  await pushSnapshot(client, review.reviewId, [{ id: review.sources[0]!.id, rootPath: repo.root }])

  return review
}

async function gatePush(client: Client) {
  const range = (await pushRange(repo.root))!
  const reading = await diffCommitRange({ id: '', rootPath: repo.root }, range)
  const infos = (await commitInfo(repo.root, range.commits)).reverse()
  const ids = await patchIds(repo.root, range.commits)

  return client.gate(
    repo.root,
    reading.fingerprint,
    reading.tree,
    range.head,
    infos.map((info) => ({
      sha: info.sha,
      patchId: ids.get(info.sha) ?? null,
      parentSha: info.parentSha,
      subject: info.subject,
    })),
  )
}

function commit(name: string): string {
  repo.write(`src/${name}.ts`, `export const ${name} = 1\n`)
  repo.commit(name)
  return repo.run('rev-parse', 'HEAD').trim()
}

const coveredShas = async (): Promise<string[]> =>
  (await ctx.db.selectFrom('approved_commit').select('sha').orderBy('sha').execute()).map(
    (row) => row.sha,
  )

describe('approving one commit', () => {
  it('covers that commit and no other', async () => {
    const client = daemon()
    const first = commit('first')
    commit('second')

    const review = await open(client)
    await submit(review.reviewId, 'approved', first)

    expect(await coveredShas()).toEqual([first])
  })

  /**
   * A fingerprint covers the whole reading. Writing one while the reviewer has
   * spoken about a single commit would clear a push they never looked at.
   */
  it('writes no fingerprint approval', async () => {
    const client = daemon()
    const first = commit('first')
    commit('second')

    const review = await open(client)
    await submit(review.reviewId, 'approved', first)

    expect(await ctx.db.selectFrom('approval').selectAll().execute()).toEqual([])
  })

  it('leaves the review open, because the rest is unread', async () => {
    const client = daemon()
    const first = commit('first')
    commit('second')

    const review = await open(client)
    await submit(review.reviewId, 'approved', first)

    const row = await ctx.db
      .selectFrom('review')
      .select('status')
      .where('id', '=', review.reviewId)
      .executeTakeFirstOrThrow()

    expect(row.status).toBe('open')
  })

  it('adds to what is covered rather than replacing it', async () => {
    const client = daemon()
    const first = commit('first')
    const second = commit('second')

    const review = await open(client)
    await submit(review.reviewId, 'approved', first)
    await submit(review.reviewId, 'approved', second)

    expect(await coveredShas()).toEqual([first, second].sort())
  })

  // The whole point: a push clears once every commit in it has been covered,
  // whether that took one verdict or five.
  it('clears the push once every commit has been covered one at a time', async () => {
    const client = daemon()
    const first = commit('first')
    const second = commit('second')

    const review = await open(client)

    await submit(review.reviewId, 'approved', first)
    expect((await gatePush(client)).decision).toBe('deny')

    await submit(review.reviewId, 'approved', second)
    expect((await gatePush(client)).decision).toBe('allow')
  })
})

describe('approving the whole change', () => {
  it('covers every commit and writes the fingerprint approval', async () => {
    const client = daemon()
    const first = commit('first')
    const second = commit('second')

    const review = await open(client)
    await submit(review.reviewId, 'approved')

    expect(await coveredShas()).toEqual([first, second].sort())
    expect(await ctx.db.selectFrom('approval').selectAll().execute()).toHaveLength(1)
  })

  it('marks the review approved', async () => {
    const client = daemon()
    commit('first')

    const review = await open(client)
    await submit(review.reviewId, 'approved')

    const row = await ctx.db
      .selectFrom('review')
      .select('status')
      .where('id', '=', review.reviewId)
      .executeTakeFirstOrThrow()

    expect(row.status).toBe('approved')
  })
})

describe('withdrawing an approval', () => {
  it('takes back the commit on screen and leaves the others covered', async () => {
    const client = daemon()
    const first = commit('first')
    const second = commit('second')

    const review = await open(client)
    await submit(review.reviewId, 'approved', first)
    await submit(review.reviewId, 'approved', second)

    await submit(review.reviewId, '', first, 'unapprove')

    expect(await coveredShas()).toEqual([second])
  })

  /**
   * The fingerprint covers the whole reading, and one commit of that reading
   * is no longer approved, so it cannot stand. Leaving it would clear a push
   * the reviewer had partly withdrawn.
   */
  it('drops the fingerprint approval too', async () => {
    const client = daemon()
    const first = commit('first')

    const review = await open(client)
    await submit(review.reviewId, 'approved')
    await submit(review.reviewId, '', first, 'unapprove')

    expect(await ctx.db.selectFrom('approval').selectAll().execute()).toEqual([])
  })

  it('takes back everything when no commit is named', async () => {
    const client = daemon()
    commit('first')
    commit('second')

    const review = await open(client)
    await submit(review.reviewId, 'approved')
    await submit(review.reviewId, '', undefined, 'unapprove')

    expect(await coveredShas()).toEqual([])
  })
})

/**
 * Requesting changes is about the review rather than about a commit, so the
 * reading on screen does not narrow it.
 */
describe('requesting changes while reading one commit', () => {
  it('withdraws every approval, not just this commit', async () => {
    const client = daemon()
    const first = commit('first')
    commit('second')

    const review = await open(client)
    await submit(review.reviewId, 'approved')
    await submit(review.reviewId, 'changes_requested', first)

    expect(await coveredShas()).toEqual([])
  })
})
