import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from './config.js'
import { tempDatabase, type TempDatabase } from './db/testing.js'
import { createReview, createSnapshot, putBlob, sha256, summarize, type Deps } from './reviews.js'
import {
  anchorFor,
  createThread,
  listThreads,
  replyToThread,
  setThreadState,
  splitLines,
  submitReview,
  turnFrom,
  unapprove,
} from './threads.js'

let ctx: TempDatabase
let deps: Deps

const FILE = ['const a = 1', 'const b = 2', 'const c = 3', 'const d = 4', 'const e = 5'].join('\n')

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

/** A review with one snapshot holding one five-line file. */
async function reviewWithFile() {
  const review = await createReview(deps, {
    title: 'one file',
    sources: [{ path: '/tmp/repo', base: 'HEAD', includeUntracked: true }],
    createdBy: 'test',
    notify: false,
  })

  const content = new TextEncoder().encode(FILE)
  const blobId = sha256(content)
  await putBlob(deps, blobId, content)

  await createSnapshot(deps, review.reviewId, {
    fingerprints: { [review.sources[0]!.id]: 'fp-1' },
    files: [
      {
        sourceId: review.sources[0]!.id,
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

  return review
}

async function humanThread(reviewId: string, body = 'rename this') {
  return createThread(deps, reviewId, {
    path: 'src/a.ts',
    line: 3,
    side: 'new',
    body,
    author: 'human',
  })
}

describe('anchoring', () => {
  it('hashes the line and its surroundings separately', () => {
    const lines = splitLines(Buffer.from(FILE, 'utf8'))
    const anchor = anchorFor(lines, 3)

    expect(anchor.line).toBe('const c = 3')
    expect(anchor.anchorHash).toHaveLength(64)
    expect(anchor.contextHash).toHaveLength(64)
    expect(anchor.anchorHash).not.toBe(anchor.contextHash)
  })

  it('keeps the anchor when only distant lines change', () => {
    const before = anchorFor(splitLines(Buffer.from(FILE, 'utf8')), 1)
    const after = anchorFor(
      splitLines(Buffer.from(FILE.replace('const e = 5', 'const e = 99'), 'utf8')),
      1,
    )

    expect(after.anchorHash).toBe(before.anchorHash)
    expect(after.contextHash).toBe(before.contextHash)
  })

  it('changes the context hash when a neighbour moves', () => {
    const before = anchorFor(splitLines(Buffer.from(FILE, 'utf8')), 3)
    const after = anchorFor(
      splitLines(Buffer.from(FILE.replace('const b = 2', 'const b = 22'), 'utf8')),
      3,
    )

    expect(after.anchorHash).toBe(before.anchorHash)
    expect(after.contextHash).not.toBe(before.contextHash)
  })

  it('drops the empty element a trailing newline leaves behind', () => {
    expect(splitLines(Buffer.from('a\nb\n', 'utf8'))).toEqual(['a', 'b'])
    expect(splitLines(Buffer.from('a\nb', 'utf8'))).toEqual(['a', 'b'])
  })
})

describe('turn', () => {
  it('is the reviewer while nothing has been submitted', () => {
    expect(turnFrom([{ author: 'human', submitted_at: null }])).toBe('human')
  })

  it('flips to the agent once the reviewer submits', () => {
    expect(turnFrom([{ author: 'human', submitted_at: 1 }])).toBe('agent')
  })

  it('flips back when the agent answers', () => {
    expect(
      turnFrom([
        { author: 'human', submitted_at: 1 },
        { author: 'agent', submitted_at: 2 },
      ]),
    ).toBe('human')
  })

  it('flips again when the reviewer answers the answer', () => {
    // The case a single open/answered column has no value for.
    expect(
      turnFrom([
        { author: 'human', submitted_at: 1 },
        { author: 'agent', submitted_at: 2 },
        { author: 'human', submitted_at: 3 },
      ]),
    ).toBe('agent')
  })

  it('ignores a draft trailing a submitted conversation', () => {
    expect(
      turnFrom([
        { author: 'human', submitted_at: 1 },
        { author: 'agent', submitted_at: 2 },
        { author: 'human', submitted_at: null },
      ]),
    ).toBe('human')
  })
})

describe('drafts', () => {
  it('hides a reviewer comment from the agent until it is submitted', async () => {
    const review = await reviewWithFile()
    await humanThread(review.reviewId)

    expect(await listThreads(deps, review.reviewId)).toHaveLength(0)
    expect(await listThreads(deps, review.reviewId, { includeDrafts: true })).toHaveLength(1)
  })

  it('sends every draft at once and counts them', async () => {
    const review = await reviewWithFile()
    await humanThread(review.reviewId, 'first')
    await humanThread(review.reviewId, 'second')

    const result = await submitReview(deps, review.reviewId, 'changes_requested')

    expect(result.messageCount).toBe(2)
    expect(result.verdict).toBe('changes_requested')

    const threads = await listThreads(deps, review.reviewId)
    expect(threads).toHaveLength(2)
    expect(threads.every((t) => t.turn === 'agent')).toBe(true)
  })

  it('submits an agent message on write, with no draft state', async () => {
    const review = await reviewWithFile()
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 2,
      side: 'new',
      body: 'I guessed here, please check',
      author: 'agent',
    })

    const threads = await listThreads(deps, review.reviewId)
    expect(threads).toHaveLength(1)
    expect(threads[0]?.origin).toBe('agent')
    // The agent asked, so the reviewer owes the answer.
    expect(threads[0]?.turn).toBe('human')
  })
})

describe('conversation', () => {
  it('survives three exchanges without changing state', async () => {
    const review = await reviewWithFile()
    const { threadId } = await humanThread(review.reviewId)
    await submitReview(deps, review.reviewId, 'changes_requested')

    await replyToThread(deps, threadId, 'done, renamed it', 'agent')
    expect((await listThreads(deps, review.reviewId))[0]?.turn).toBe('human')

    await replyToThread(deps, threadId, 'not quite what I meant', 'human')
    await submitReview(deps, review.reviewId, 'comment')

    const threads = await listThreads(deps, review.reviewId)
    expect(threads[0]?.state).toBe('active')
    expect(threads[0]?.turn).toBe('agent')
    expect(threads[0]?.messages).toHaveLength(3)
  })

  it('filters by whose turn it is, which is what an agent asks', async () => {
    const review = await reviewWithFile()
    const { threadId } = await humanThread(review.reviewId, 'needs work')
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 1,
      side: 'new',
      body: 'a question for you',
      author: 'agent',
    })
    await submitReview(deps, review.reviewId, 'changes_requested')

    const owed = await listThreads(deps, review.reviewId, { turn: 'agent' })
    expect(owed).toHaveLength(1)
    expect(owed[0]?.id).toBe(threadId)
  })

  it('resolves a thread and drops it from the active filter', async () => {
    const review = await reviewWithFile()
    const { threadId } = await humanThread(review.reviewId)
    await submitReview(deps, review.reviewId, 'changes_requested')

    await setThreadState(deps, threadId, 'resolved', 'fixed in the next snapshot')

    expect(await listThreads(deps, review.reviewId, { state: 'active' })).toHaveLength(0)
    const resolved = await listThreads(deps, review.reviewId, { state: 'resolved' })
    expect(resolved[0]?.messages).toHaveLength(2)
  })
})

describe('approval', () => {
  it('writes one approval per source carrying that root fingerprint', async () => {
    const review = await reviewWithFile()
    await submitReview(deps, review.reviewId, 'approved')

    const approvals = await ctx.db.selectFrom('approval').selectAll().execute()
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      root_path: '/tmp/repo',
      fingerprint: 'fp-1',
      consumed_at: null,
    })

    expect((await summarize(deps, review.reviewId)).status).toBe('approved')
  })

  it('approves with threads still open, because that is the reviewer to decide', async () => {
    const review = await reviewWithFile()
    await humanThread(review.reviewId, 'worth thinking about later')

    await expect(submitReview(deps, review.reviewId, 'approved')).resolves.toMatchObject({
      verdict: 'approved',
    })

    const threads = await listThreads(deps, review.reviewId)
    expect(threads[0]?.state).toBe('active')
    expect(await ctx.db.selectFrom('approval').selectAll().execute()).toHaveLength(1)
  })

  it('lets the reviewer take an approval back before a commit uses it', async () => {
    const review = await reviewWithFile()
    await submitReview(deps, review.reviewId, 'approved')

    expect(await unapprove(deps, review.reviewId)).toEqual({ removed: 1 })
    expect((await summarize(deps, review.reviewId)).status).toBe('open')
  })

  it('replaces the previous approval rather than stacking a second', async () => {
    const review = await reviewWithFile()
    await submitReview(deps, review.reviewId, 'approved')
    await submitReview(deps, review.reviewId, 'approved')

    expect(await ctx.db.selectFrom('approval').selectAll().execute()).toHaveLength(1)
  })
})

describe('errors', () => {
  it('refuses a thread on a review with no snapshot', async () => {
    const review = await createReview(deps, {
      title: 'nothing pushed yet',
      sources: [{ path: '/tmp/repo', base: 'HEAD', includeUntracked: true }],
      createdBy: '',
      notify: false,
    })

    await expect(humanThread(review.reviewId)).rejects.toThrow(/no snapshot/)
  })

  it('refuses a thread on a path the snapshot does not hold', async () => {
    const review = await reviewWithFile()

    await expect(
      createThread(deps, review.reviewId, {
        path: 'src/nowhere.ts',
        line: 1,
        side: 'new',
        body: 'x',
        author: 'human',
      }),
    ).rejects.toThrow(/not in this review/)
  })

  it('refuses a reply to a thread that does not exist', async () => {
    await expect(replyToThread(deps, 'nope', 'hello', 'agent')).rejects.toMatchObject({
      status: 404,
    })
  })
})
