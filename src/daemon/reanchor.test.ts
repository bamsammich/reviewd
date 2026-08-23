import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from './config.js'
import { tempDatabase, type TempDatabase } from './db/testing.js'
import { locate, locateEnd } from './reanchor.js'
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

/**
 * A range's end is placed by length and then checked against its own hash.
 *
 * Searching for the end the way the start is found would not work: a range
 * usually ends on something unremarkable like a closing brace, and the search
 * would land on the wrong one. Carrying the length alone would not work either,
 * because arithmetic cannot tell a range that survived from one whose middle
 * grew. So it does both.
 */
describe('locateEnd', () => {
  // Lines 5 to 7 of ORIGINAL: the whole of `function two`.
  const range = {
    line: 5,
    end_line: 7,
    end_anchor_hash: anchorFor(ORIGINAL, 7).anchorHash,
  }

  it('leaves a single-line comment without an end', () => {
    const single = { line: 5, end_line: null, end_anchor_hash: null }

    expect(locateEnd(ORIGINAL, single, 5)).toEqual({ endLine: null, drifted: false })
  })

  it('carries the length when the whole block moved', () => {
    const shifted = ['// a new header', '', ...ORIGINAL]

    expect(locateEnd(shifted, range, 7)).toEqual({ endLine: 9, drifted: false })
  })

  it('keeps the range and flags drift when the block grew', () => {
    // A line added inside the range pushes its old end down, so the end lands
    // on something that is no longer what the comment was written about.
    const grown = [...ORIGINAL.slice(0, 5), '  const x = 1', ...ORIGINAL.slice(5)]

    expect(locateEnd(grown, range, 5)).toEqual({ endLine: 7, drifted: true })
  })

  it('covers what is left when the range runs off the end of the file', () => {
    const truncated = ORIGINAL.slice(0, 6)

    expect(locateEnd(truncated, range, 5)).toEqual({ endLine: 6, drifted: true })
  })

  it('never returns an end before its start', () => {
    const found = locateEnd(ORIGINAL.slice(0, 3), range, 3)

    expect(found.endLine).toBeGreaterThanOrEqual(3)
  })
})

describe('a comment covering a range, through a real snapshot', () => {
  const aboutFunctionTwo = (reviewId: string) =>
    createThread(deps, reviewId, {
      path: 'src/a.ts',
      line: 5,
      endLine: 7,
      side: 'new',
      body: 'this whole function',
      author: 'human',
    })

  it('stores both ends', async () => {
    const review = await reviewWith(ORIGINAL)
    await aboutFunctionTwo(review.reviewId)

    const row = await threadRow()
    expect(row.line).toBe(5)
    expect(row.end_line).toBe(7)
    expect(row.end_anchor_hash).toBe(anchorFor(ORIGINAL, 7).anchorHash)
  })

  it('moves both ends when the block is pushed down', async () => {
    const review = await reviewWith(ORIGINAL)
    await aboutFunctionTwo(review.reviewId)

    await push(
      review.reviewId,
      review.sources[0]!.id,
      ['// added', '// lines', ...ORIGINAL],
      'fp-2',
    )

    const row = await threadRow()
    expect({ line: row.line, end: row.end_line, drifted: row.drifted }).toEqual({
      line: 7,
      end: 9,
      drifted: 0,
    })
  })

  it('keeps the comment and says it drifted when the block grew', async () => {
    const review = await reviewWith(ORIGINAL)
    await aboutFunctionTwo(review.reviewId)

    await push(
      review.reviewId,
      review.sources[0]!.id,
      [...ORIGINAL.slice(0, 5), '  const x = 1', ...ORIGINAL.slice(5)],
      'fp-2',
    )

    const row = await threadRow()
    expect(row.state).toBe('active')
    expect(row.drifted).toBe(1)
  })

  // Every thread written before ranges existed has a null end, and must go on
  // behaving exactly as it did.
  it('leaves a single-line comment single-line', async () => {
    const review = await reviewWith(ORIGINAL)
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 6,
      side: 'new',
      body: 'why 2?',
      author: 'human',
    })

    await push(review.reviewId, review.sources[0]!.id, ['// added', ...ORIGINAL], 'fp-2')

    const row = await threadRow()
    expect({ line: row.line, end: row.end_line }).toEqual({ line: 7, end: null })
  })

  it('refuses a range that ends before it starts', async () => {
    const review = await reviewWith(ORIGINAL)

    await expect(
      createThread(deps, review.reviewId, {
        path: 'src/a.ts',
        line: 7,
        endLine: 5,
        side: 'new',
        body: 'backwards',
        author: 'human',
      }),
    ).rejects.toThrow()
  })

  // Found by dogfooding: a range ending on line 280 of a 277-line file was
  // accepted, and stored the hash of the empty string as its end. Nothing
  // matches that later, so the comment would have been drifted forever for a
  // reason that was really a bad request.
  it('refuses a range that ends past the end of the file', async () => {
    const review = await reviewWith(ORIGINAL)

    await expect(
      createThread(deps, review.reviewId, {
        path: 'src/a.ts',
        line: 5,
        endLine: ORIGINAL.length + 3,
        side: 'new',
        body: 'off the end',
        author: 'human',
      }),
    ).rejects.toThrow(/there is no line/)
  })

  it('refuses a single line past the end of the file too', async () => {
    const review = await reviewWith(ORIGINAL)

    await expect(
      createThread(deps, review.reviewId, {
        path: 'src/a.ts',
        line: ORIGINAL.length + 1,
        side: 'new',
        body: 'off the end',
        author: 'human',
      }),
    ).rejects.toThrow(/there is no line/)
  })

  it('accepts a range ending on the last line', async () => {
    const review = await reviewWith(ORIGINAL)
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 5,
      endLine: ORIGINAL.length,
      side: 'new',
      body: 'to the end',
      author: 'human',
    })

    expect((await threadRow()).end_line).toBe(ORIGINAL.length)
  })

  it('stores a range that ends where it starts as one line', async () => {
    const review = await reviewWith(ORIGINAL)
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 5,
      endLine: 5,
      side: 'new',
      body: 'just this line',
      author: 'human',
    })

    expect((await threadRow()).end_line).toBeNull()
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
