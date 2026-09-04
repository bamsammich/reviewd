import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from '../daemon/config.js'
import { tempDatabase, type TempDatabase } from '../daemon/db/testing.js'
import { createApp, type App } from '../daemon/http/app.js'
import { sourceSummary } from '../protocol.js'
import { Client } from './client.js'
import { diffSource } from './diff.js'
import { pushSnapshot } from './push.js'
import { tempRepo, type TempRepo } from './testing.js'

/**
 * A review scoped to one directory of a repository, and what lands afterwards.
 *
 * `reviewd observe` compares `git rev-parse HEAD^{tree}` against the tree the
 * gate recorded, and both cover the whole repository. A review whose source is
 * a subdirectory covers part of it, so the two are answering different
 * questions and nobody wrote down which.
 */

let ctx: TempDatabase
let app: App
let repo: TempRepo

beforeEach(async () => {
  ctx = await tempDatabase()

  repo = tempRepo()
  repo.write('api/server.ts', 'export const port = 7777\n')
  repo.write('web/page.ts', 'export const title = "hello"\n')
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
    { configPath: '/tmp/reviewd-subdir.json', bindPublic: false },
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

/** A review of one directory rather than of the repository. */
async function reviewApiOnly(client: Client): Promise<void> {
  const sub = `${repo.root}/api`

  const review = await client.createReview({
    title: 'a change in api',
    sources: [{ path: sub }],
    createdBy: 'test',
    notify: false,
  })

  await pushSnapshot(client, review.reviewId, [{ id: review.sources[0]!.id, rootPath: sub }])
  await approve(review.reviewId)
}

/** The gate call the hook makes, scoped the way the review is. */
async function gate(client: Client) {
  const sub = `${repo.root}/api`
  const reading = await diffSource({ id: '', rootPath: sub })
  const head = repo.run('rev-parse', 'HEAD').trim()

  return client.gate(sub, reading.fingerprint, reading.tree, head)
}

async function observe(client: Client, root: string) {
  const head = repo.run('rev-parse', 'HEAD').trim()
  const tree = repo.run('rev-parse', 'HEAD^{tree}').trim()

  return client.observe(root, head, tree)
}

describe('the gate, on a review scoped to one directory', () => {
  /**
   * The hook resolves the repository a command acts on, which is the root git
   * reports rather than whatever path was reviewed. An approval recorded
   * against a subdirectory is keyed on that subdirectory.
   */
  it('is asked about the repository root, not the reviewed directory', async () => {
    const client = daemon()

    repo.write('api/server.ts', 'export const port = 8888\n')
    await reviewApiOnly(client)

    const reading = await diffSource({ id: '', rootPath: repo.root })
    const head = repo.run('rev-parse', 'HEAD').trim()
    const asRoot = await client.gate(repo.root, reading.fingerprint, reading.tree, head)

    expect(asRoot.decision).toBe('deny')
    expect(asRoot.reason).toContain('Nobody has looked at')
  })
})

describe('a review scoped to one directory', () => {
  it('reads as clean when only that directory changed', async () => {
    const client = daemon()

    repo.write('api/server.ts', 'export const port = 8888\n')
    await reviewApiOnly(client)
    await gate(client)
    repo.commit('change the port')

    // The root `reviewd observe` resolves, which is what the command asks
    // about: it runs `repoRoot`, never the reviewed path.
    const result = await observe(client, repo.root)

    expect(result.finding).toBe('clean')
  })

  /**
   * The case the task was filed for. A commit touching a directory the review
   * never covered should not read as the approved one having been altered.
   */
  it('reads as clean when a sibling directory changed', async () => {
    const client = daemon()

    repo.write('api/server.ts', 'export const port = 8888\n')
    await reviewApiOnly(client)
    await gate(client)
    repo.commit('change the port')

    repo.write('web/page.ts', 'export const title = "goodbye"\n')
    repo.commit('unrelated work in web')

    const result = await observe(client, repo.root)

    expect(result.finding).toBe('clean')
    expect(result.reason).toContain('no review covers')
  })
})

describe('a source that cannot gate', () => {
  /**
   * The flag is the client's to set, since the daemon never runs git and
   * cannot tell a directory inside a repository from one outside every
   * repository.
   */
  it('is carried back on the review', async () => {
    const client = daemon()
    const sub = `${repo.root}/api`

    const review = await client.createReview({
      title: 'part of a repository',
      sources: [{ path: sub, gates: false }],
      createdBy: 'test',
      notify: false,
    })

    expect(review.sources[0]!.gates).toBe(false)
  })

  it('reads as gating when the client says nothing', async () => {
    const client = daemon()

    const review = await client.createReview({
      title: 'a whole repository',
      sources: [{ path: repo.root, base: 'HEAD' }],
      createdBy: 'test',
      notify: false,
    })

    expect(review.sources[0]!.gates).toBe(true)
  })

  it('says so on the page, where somebody is about to approve', async () => {
    const client = daemon()
    const sub = `${repo.root}/api`

    const review = await client.createReview({
      title: 'part of a repository',
      sources: [{ path: sub, gates: false }],
      createdBy: 'test',
      notify: false,
    })
    await pushSnapshot(client, review.reviewId, [{ id: review.sources[0]!.id, rootPath: sub }])

    const page = await app.request(`/r/${review.reviewId}`, {
      headers: { host: '127.0.0.1:7777' },
    })
    const markup = await page.text()

    // The rendered element, not the word: the stylesheet is inlined into every
    // page, so the class name is present whether or not anything wears it.
    expect(markup).toContain('class="badge nogate"')
    expect(markup).toContain('>no gate<')
  })

  it('says nothing on a review of a whole repository', async () => {
    const client = daemon()

    const review = await client.createReview({
      title: 'a whole repository',
      sources: [{ path: repo.root, base: 'HEAD' }],
      createdBy: 'test',
      notify: false,
    })
    await pushSnapshot(client, review.reviewId, [
      { id: review.sources[0]!.id, rootPath: repo.root },
    ])

    const page = await app.request(`/r/${review.reviewId}`, {
      headers: { host: '127.0.0.1:7777' },
    })

    expect(await page.text()).not.toContain('class="badge nogate"')
  })
})

/**
 * The condition on this whole change: saying a review cannot gate must not
 * change what the gate does.
 */
describe('the gate, with the flag set', () => {
  it('denies the repository exactly as it did before', async () => {
    const client = daemon()
    const sub = `${repo.root}/api`

    repo.write('api/server.ts', 'export const port = 8888\n')

    const review = await client.createReview({
      title: 'part of a repository',
      sources: [{ path: sub, gates: false }],
      createdBy: 'test',
      notify: false,
    })
    await pushSnapshot(client, review.reviewId, [{ id: review.sources[0]!.id, rootPath: sub }])
    await approve(review.reviewId)

    const reading = await diffSource({ id: '', rootPath: repo.root })
    const head = repo.run('rev-parse', 'HEAD').trim()
    const verdict = await client.gate(repo.root, reading.fingerprint, reading.tree, head)

    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('Nobody has looked at')
  })

  it('leaves observe silent, exactly as it was', async () => {
    const client = daemon()
    const sub = `${repo.root}/api`

    repo.write('api/server.ts', 'export const port = 8888\n')

    const review = await client.createReview({
      title: 'part of a repository',
      sources: [{ path: sub, gates: false }],
      createdBy: 'test',
      notify: false,
    })
    await pushSnapshot(client, review.reviewId, [{ id: review.sources[0]!.id, rootPath: sub }])
    await approve(review.reviewId)
    repo.commit('change the port')

    const result = await observe(client, repo.root)

    expect(result.finding).toBe('clean')
    expect(result.reason).toContain('no review covers')
  })
})

/**
 * A daemon older than the field, which is a container restart behind on every
 * machine that runs one.
 *
 * The first build of this change required `gates` in the response, so a new
 * client could not talk to a daemon that had not been upgraded: every call
 * failed with "unexpected shape". Found by running it against the real daemon
 * rather than by any test, because a test builds both halves from the same
 * source and never sees the two versions apart.
 */
describe('a response from a daemon that predates the field', () => {
  it('reads as gating rather than failing to parse', () => {
    const older = {
      id: 'src-1',
      label: 'api',
      rootPath: '/tmp/api',
      vcs: 'git' as const,
      baseRef: 'HEAD',
      approved: false,
    }

    const parsed = sourceSummary.parse(older)

    expect(parsed.gates).toBe(true)
  })
})
