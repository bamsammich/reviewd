import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from './config.js'
import { tempDatabase, type TempDatabase } from './db/testing.js'
import { locate } from './reanchor.js'
import { createReview, createSnapshot, putBlob, sha256, type Deps } from './reviews.js'
import { anchorFor, createThread, listThreads, splitLines, submitReview } from './threads.js'

let ctx: TempDatabase
let deps: Deps

const ORIGINAL = ['function one() {', '  return 1', '}', '', 'function two() {', '  return 2', '}']

beforeEach(async () => {
  ctx = await tempDatabase()
  const config = resolve(configSchema.parse({}), {
    configPath: '/tmp/reviewd-test.json',
    bindPublic: false,
  })
  deps = { db: ctx.db, config }
})

afterEach(async () => {
  await ctx.close()
})

async function reviewWith(lines: string[]) {
  const review = await createReview(deps, {
    title: 'anchoring',
    sources: [{ path: '/tmp/repo', base: 'HEAD', includeUntracked: true }],
    createdBy: '',
    notify: false,
  })

  await push(review.reviewId, review.sources[0]!.id, lines, 'fp-1')
  return review
}

async function push(reviewId: string, sourceId: string, lines: string[], fingerprint: string) {
  const content = new TextEncoder().encode(`${lines.join('\n')}\n`)
  const blobId = sha256(content)
  await putBlob(deps, blobId, content)

  return createSnapshot(deps, reviewId, {
    fingerprints: { [sourceId]: fingerprint },
    files: [
      {
        sourceId,
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
}

/** The thread's own view of where it sits, straight from the database. */
async function threadRow() {
  return ctx.db.selectFrom('thread').selectAll().executeTakeFirstOrThrow()
}

describe('locate', () => {
  const anchor = anchorFor(ORIGINAL, 6)
  const thread = { line: 6, anchor_hash: anchor.anchorHash, context_hash: anchor.contextHash }

  it('keeps a line that has not moved', () => {
    const found = locate(ORIGINAL, thread)

    expect(found).toMatchObject({ line: 6, drifted: false })
  })

  it('follows a line pushed down by an insertion above it', () => {
    const shifted = ['// a new header', '', ...ORIGINAL]

    expect(locate(shifted, thread)).toMatchObject({ line: 8, drifted: false })
  })

  it('follows a line pulled up by a distant deletion', () => {
    // One line removed well above the anchor, so the neighbourhood it was
    // written about is intact and only its number moved.
    const shortened = ORIGINAL.slice(1)

    expect(locate(shortened, thread)).toMatchObject({ line: 5, drifted: false })
  })

  it('flags drift when the deletion reaches into the surrounding lines', () => {
    // Three lines gone, one of them inside the window the anchor covers. The
    // comment still belongs on that line, and the code around it is not what
    // it was written about.
    expect(locate(ORIGINAL.slice(3), thread)).toMatchObject({ line: 3, drifted: true })
  })

  it('flags a line whose surroundings changed', () => {
    const rewritten = [...ORIGINAL]
    rewritten[4] = 'function renamed() {'

    const found = locate(rewritten, thread)

    expect(found?.line).toBe(6)
    // The line survived but the code it was written about did not.
    expect(found?.drifted).toBe(true)
  })

  it('prefers the copy whose surroundings match when a line repeats', () => {
    const duplicated = ['  return 2', '// unrelated', ...ORIGINAL]

    expect(locate(duplicated, thread)).toMatchObject({ line: 8, drifted: false })
  })

  it('finds nothing when the line is gone', () => {
    const without = ORIGINAL.filter((line) => line !== '  return 2')

    expect(locate(without, thread)).toBeUndefined()
  })

  it('splits content the same way the anchor was built from', () => {
    expect(splitLines(Buffer.from(`${ORIGINAL.join('\n')}\n`, 'utf8'))).toEqual(ORIGINAL)
  })
})

describe('re-anchoring a snapshot', () => {
  it('moves a comment down when lines are added above it', async () => {
    const review = await reviewWith(ORIGINAL)
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 6,
      side: 'new',
      body: 'why 2?',
      author: 'human',
    })

    expect((await threadRow()).line).toBe(6)

    const result = await push(
      review.reviewId,
      review.sources[0]!.id,
      ['// added', '// lines', ...ORIGINAL],
      'fp-2',
    )

    expect(result.threadsMoved).toBe(1)
    expect(result.threadsOutdated).toBe(0)

    const row = await threadRow()
    expect(row.line).toBe(8)
    expect(row.state).toBe('active')
    expect(row.drifted).toBe(0)
  })

  it('leaves a comment alone when nothing near it changed', async () => {
    const review = await reviewWith(ORIGINAL)
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 2,
      side: 'new',
      body: 'fine as is',
      author: 'human',
    })

    const changed = [...ORIGINAL]
    changed[6] = '} // trailing note'

    const result = await push(review.reviewId, review.sources[0]!.id, changed, 'fp-2')

    expect(result.threadsMoved).toBe(0)
    expect((await threadRow()).line).toBe(2)
  })

  it('marks a comment outdated when its line is gone', async () => {
    const review = await reviewWith(ORIGINAL)
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 6,
      side: 'new',
      body: 'about to vanish',
      author: 'human',
    })

    const result = await push(
      review.reviewId,
      review.sources[0]!.id,
      ORIGINAL.filter((line) => line !== '  return 2'),
      'fp-2',
    )

    expect(result.threadsOutdated).toBe(1)
    expect((await threadRow()).state).toBe('outdated')
  })

  it('marks a comment outdated when its file leaves the change set', async () => {
    const review = await reviewWith(ORIGINAL)
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 2,
      side: 'new',
      body: 'orphaned',
      author: 'human',
    })

    await createSnapshot(deps, review.reviewId, {
      fingerprints: { [review.sources[0]!.id]: 'fp-empty' },
      files: [],
    })

    expect((await threadRow()).state).toBe('outdated')
  })

  it('leaves a resolved thread where it lies', async () => {
    const review = await reviewWith(ORIGINAL)
    const { threadId } = await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 6,
      side: 'new',
      body: 'handled',
      author: 'human',
    })

    await submitReview(deps, review.reviewId, 'changes_requested')
    await ctx.db
      .updateTable('thread')
      .set({ state: 'resolved' })
      .where('id', '=', threadId)
      .execute()

    await push(review.reviewId, review.sources[0]!.id, ['// added', ...ORIGINAL], 'fp-2')

    const row = await threadRow()
    expect(row.state).toBe('resolved')
    expect(row.line).toBe(6)
  })

  it('re-anchors a draft-only thread like any other', async () => {
    // Invisible to the agent, but it still has to survive the edit.
    const review = await reviewWith(ORIGINAL)
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 6,
      side: 'new',
      body: 'unsent',
      author: 'human',
    })

    await push(review.reviewId, review.sources[0]!.id, ['// added', ...ORIGINAL], 'fp-2')

    expect((await threadRow()).line).toBe(7)
    expect(await listThreads(deps, review.reviewId)).toHaveLength(0)
    expect(await listThreads(deps, review.reviewId, { includeDrafts: true })).toHaveLength(1)
  })

  it('revives an outdated thread when the code comes back', async () => {
    const review = await reviewWith(ORIGINAL)
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 6,
      side: 'new',
      body: 'comes and goes',
      author: 'human',
    })

    await push(
      review.reviewId,
      review.sources[0]!.id,
      ORIGINAL.filter((line) => line !== '  return 2'),
      'fp-2',
    )
    expect((await threadRow()).state).toBe('outdated')

    await push(review.reviewId, review.sources[0]!.id, ORIGINAL, 'fp-3')
    expect((await threadRow()).state).toBe('active')
  })
})
