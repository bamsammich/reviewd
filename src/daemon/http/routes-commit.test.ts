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

/**
 * A comment left while reading one commit.
 *
 * The line as commit one left it is not the line the combined diff holds, so a
 * note about it belongs to the commit rather than to the push.
 */
describe('commenting on a commit', () => {
  const post = async (path: string, form: Record<string, string>) => {
    // The page token, which every form on the page is minted from. A form's
    // own token field only exists once a comment box is open.
    const page = await read(path.split('/threads')[0] as string)
    const token = /id="page-token"[^>]*value="([^"]+)"/.exec(page)?.[1] ?? ''

    return app.request(path.split('?')[0] as string, {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...form, token }).toString(),
      redirect: 'manual',
    })
  }

  async function commentOnFirstCommit(reviewId: string, body: string) {
    const source = (
      await ctx.db.selectFrom('source').select('id').where('review_id', '=', reviewId).execute()
    )[0]!.id

    return post(`/r/${reviewId}/threads`, {
      sourceId: source,
      path: 'src/a.ts',
      side: 'new',
      line: '1',
      commitSha: 'aaaaaaa1111',
      body,
    })
  }

  it('files it against the commit, not the push', async () => {
    const review = await pushOfTwoCommits()
    await commentOnFirstCommit(review.reviewId, 'this is the state I meant')

    const rows = await ctx.db.selectFrom('thread').select(['commit_sha', 'path']).execute()
    expect(rows).toEqual([{ commit_sha: 'aaaaaaa1111', path: 'src/a.ts' }])
  })

  it('draws it on its commit and not on the whole change', async () => {
    const review = await pushOfTwoCommits()
    await commentOnFirstCommit(review.reviewId, 'this is the state I meant')

    const id = (await ctx.db.selectFrom('thread').select('id').execute())[0]!.id
    const onCommit = await read(`/r/${review.reviewId}?commit=aaaaaaa1111`)
    const combined = await read(`/r/${review.reviewId}`)

    // The thread itself, not its text: the comment index on the combined view
    // names it on purpose, which is how a reader finds it from there.
    expect(onCommit).toContain(`<div class="thread active" id="t-${id}"`)
    expect(combined).not.toContain(`<div class="thread active" id="t-${id}"`)
    expect(combined).toContain('this is the state I meant')
  })

  // The index is the page's answer to "where are my comments", so a note on a
  // view the reader is not looking at is exactly the one it has to carry.
  it('lists it from the whole change, pointing at its commit', async () => {
    const review = await pushOfTwoCommits()
    await commentOnFirstCommit(review.reviewId, 'this is the state I meant')

    const combined = await read(`/r/${review.reviewId}`)

    expect(combined).toContain('?commit=aaaaaaa1111#t-')
    expect(combined).toContain('on aaaaaaa')
  })

  it('refuses a commit this revision does not carry', async () => {
    const review = await pushOfTwoCommits()
    const source = (
      await ctx.db
        .selectFrom('source')
        .select('id')
        .where('review_id', '=', review.reviewId)
        .execute()
    )[0]!.id

    const response = await post(`/r/${review.reviewId}/threads`, {
      sourceId: source,
      path: 'src/a.ts',
      side: 'new',
      line: '1',
      commitSha: 'deadbeef',
      body: 'against a commit that is not here',
    })

    // Refused rather than quietly filed against the combined change set: a
    // comment moved to a different reading of the code is worse than one that
    // did not save.
    expect(response.status).toBe(400)
    expect(await ctx.db.selectFrom('thread').selectAll().execute()).toEqual([])
  })
})

/**
 * Editing a comment left on a commit.
 *
 * The comment draws only on its commit, so a save that redirects to the whole
 * change lands the reviewer on a page their comment is not on.
 */
describe('editing a comment on a commit', () => {
  async function draftOnFirstCommit(reviewId: string) {
    const source = (
      await ctx.db.selectFrom('source').select('id').where('review_id', '=', reviewId).execute()
    )[0]!.id

    const page = await read(`/r/${reviewId}`)
    const token = /id="page-token"[^>]*value="([^"]+)"/.exec(page)?.[1] ?? ''

    await app.request(`/r/${reviewId}/threads`, {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        sourceId: source,
        path: 'src/a.ts',
        side: 'new',
        line: '1',
        commitSha: 'aaaaaaa1111',
        body: 'first take',
      }).toString(),
    })

    const message = await ctx.db.selectFrom('message').select('id').executeTakeFirstOrThrow()
    return { messageId: message.id, token }
  }

  it('opens the editor from the address, in place of the comment', async () => {
    const review = await pushOfTwoCommits()
    const { messageId } = await draftOnFirstCommit(review.reviewId)

    const html = await read(`/r/${review.reviewId}?edit=${messageId}&commit=aaaaaaa1111`)

    expect(html).toContain('first take</textarea>')
    expect(html).toContain('class="editing"')
  })

  it('comes back to the commit after saving, not to the whole change', async () => {
    const review = await pushOfTwoCommits()
    const { messageId, token } = await draftOnFirstCommit(review.reviewId)

    const response = await app.request(`/r/${review.reviewId}/messages/${messageId}`, {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        body: 'second take',
        commitSha: 'aaaaaaa1111',
      }).toString(),
      redirect: 'manual',
    })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('?commit=aaaaaaa1111')
  })

  it('stays on the commit after deleting', async () => {
    const review = await pushOfTwoCommits()
    const { messageId, token } = await draftOnFirstCommit(review.reviewId)

    const response = await app.request(`/r/${review.reviewId}/messages/${messageId}/delete`, {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, commitSha: 'aaaaaaa1111' }).toString(),
      redirect: 'manual',
    })

    expect(response.headers.get('location')).toBe(`/r/${review.reviewId}?commit=aaaaaaa1111`)
    expect(await ctx.db.selectFrom('thread').selectAll().execute()).toEqual([])
  })
})

/**
 * What a revision is a reading of, said before anything else.
 *
 * A revision carrying commits was built from the commits no remote has yet,
 * which excludes anything uncommitted. Someone reviewing a stack that had
 * never been pushed read that page, found their working tree missing from it,
 * and could not tell whether the review or their memory was wrong.
 */
describe('saying what the revision covers', () => {
  it('names the reading when the revision is a push', async () => {
    const review = await pushOfTwoCommits()
    const html = await read(`/r/${review.reviewId}`)

    expect(html).toContain('class="reading"')
    expect(html).toContain('2 commits, which is what this push would carry')
    expect(html).toContain('uncommitted is not part of it')
  })

  // A revision with no commits is the working tree against a base, which looks
  // like every diff anybody has read and needs no explaining.
  it('says nothing for a review of a working tree', async () => {
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

    expect(await read(`/r/${review.reviewId}`)).not.toContain('class="reading"')
  })

  // Reading one commit already says what it is, in the strip that names it.
  it('stands aside once a commit is chosen', async () => {
    const review = await pushOfTwoCommits()
    const html = await read(`/r/${review.reviewId}?commit=aaaaaaa1111`)

    expect(html).not.toContain('class="reading"')
    expect(html).toContain('<div class="readingcommit">')
  })
})
