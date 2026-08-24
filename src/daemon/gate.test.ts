import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from './config.js'
import { tempDatabase, type TempDatabase } from './db/testing.js'
import { gate, release, sweepOrphanBlobs } from './gate.js'
import { manifestFingerprint } from '../fingerprint.js'
import { createReview, createSnapshot, putBlob, sha256, type Deps } from './reviews.js'
import { createThread, submitReview } from './threads.js'

let ctx: TempDatabase
let deps: Deps

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

/**
 * A review whose fingerprint follows from its content, as a real one does.
 *
 * `marker` stands in for the bytes under review: two reviews sharing one get
 * the same fingerprint, and two that differ get different ones. The daemon
 * derives the value, so a test cannot hand it a name and must go through the
 * content, which is the property being tested.
 */
async function reviewAt(root: string, marker: string, title = 'a review') {
  const review = await createReview(deps, {
    title,
    sources: [{ path: root, base: 'HEAD', includeUntracked: true }],
    createdBy: 'test',
    notify: false,
  })

  const content = new TextEncoder().encode(`const a = 1\n// ${marker}\n`)
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

/** The fingerprint the daemon derived for a marker, which is what the gate wants. */
function fingerprintFor(marker: string): string {
  const blobId = sha256(new TextEncoder().encode(`const a = 1\n// ${marker}\n`))

  return manifestFingerprint([
    {
      sourceId: '',
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
  ])
}

describe('allow', () => {
  it('needs only a matching root and fingerprint', async () => {
    const review = await reviewAt('/tmp/repo', 'fp-1')
    await submitReview(deps, review.reviewId, 'approved')

    const result = await gate(deps, { root: '/tmp/repo', fingerprint: fingerprintFor('fp-1') })

    expect(result.decision).toBe('allow')
    expect(result.reviewUrl).toContain(review.reviewId)
  })

  it('allows with threads still open, and says so in a warning', async () => {
    const review = await reviewAt('/tmp/repo', 'fp-1')
    await createThread(deps, review.reviewId, {
      path: 'src/a.ts',
      line: 2,
      side: 'new',
      body: 'worth revisiting',
      author: 'human',
    })
    await submitReview(deps, review.reviewId, 'approved')

    const result = await gate(deps, { root: '/tmp/repo', fingerprint: fingerprintFor('fp-1') })

    expect(result.decision).toBe('allow')
    expect(result.warnings).toContain('1 thread still open on this review')
    expect(result.openThreads[0]).toMatchObject({ path: 'src/a.ts', line: 2 })
  })

  it('warns when a second review also covers the root', async () => {
    const mine = await reviewAt('/tmp/repo', 'fp-1', 'mine')
    await reviewAt('/tmp/repo', 'fp-other', 'another session')
    await submitReview(deps, mine.reviewId, 'approved')

    const result = await gate(deps, { root: '/tmp/repo', fingerprint: fingerprintFor('fp-1') })

    expect(result.decision).toBe('allow')
    expect(result.warnings.some((w) => w.includes('also covers'))).toBe(true)
  })

  it('honors an approval from another review of the same bytes', async () => {
    // Binding to content rather than to a review id is what makes concurrent
    // reviews safe. These are the exact bytes someone approved.
    const first = await reviewAt('/tmp/repo', 'fp-shared', 'first')
    await reviewAt('/tmp/repo', 'fp-shared', 'second')
    await submitReview(deps, first.reviewId, 'approved')

    expect(
      (await gate(deps, { root: '/tmp/repo', fingerprint: fingerprintFor('fp-shared') })).decision,
    ).toBe('allow')
  })

  it('refuses to let one repository authorize a commit in another', async () => {
    const review = await reviewAt('/tmp/repo-a', 'fp-1')
    await submitReview(deps, review.reviewId, 'approved')

    const result = await gate(deps, { root: '/tmp/repo-b', fingerprint: fingerprintFor('fp-1') })
    expect(result.decision).toBe('deny')
  })
})

describe('consumed_at', () => {
  it('stamps on the first matching call', async () => {
    const review = await reviewAt('/tmp/repo', 'fp-1')
    await submitReview(deps, review.reviewId, 'approved')

    expect(
      (await ctx.db.selectFrom('approval').selectAll().executeTakeFirstOrThrow()).consumed_at,
    ).toBeNull()

    await gate(deps, { root: '/tmp/repo', fingerprint: fingerprintFor('fp-1') })

    expect(
      (await ctx.db.selectFrom('approval').selectAll().executeTakeFirstOrThrow()).consumed_at,
    ).not.toBeNull()
  })

  it('does not invalidate the approval, so a retry still passes', async () => {
    // A commit can fail for reasons that have nothing to do with the review.
    const review = await reviewAt('/tmp/repo', 'fp-1')
    await submitReview(deps, review.reviewId, 'approved')

    await gate(deps, { root: '/tmp/repo', fingerprint: fingerprintFor('fp-1') })
    const retry = await gate(deps, { root: '/tmp/repo', fingerprint: fingerprintFor('fp-1') })

    expect(retry.decision).toBe('allow')
  })
})

describe('deny reasons', () => {
  it('says nobody has looked when no review covers the root', async () => {
    const result = await gate(deps, { root: '/tmp/untouched', fingerprint: 'fp' })

    expect(result.decision).toBe('deny')
    expect(result.reason).toMatch(/Nobody has looked/)
    expect(result.reviewUrl).toBeNull()
  })

  it('says the review is open but unapproved', async () => {
    await reviewAt('/tmp/repo', 'fp-1')

    const result = await gate(deps, { root: '/tmp/repo', fingerprint: fingerprintFor('fp-1') })

    expect(result.decision).toBe('deny')
    expect(result.reason).toMatch(/has not been approved/)
    expect(result.reviewUrl).not.toBeNull()
  })

  it('names the snapshot when the tree moved after approval', async () => {
    const review = await reviewAt('/tmp/repo', 'fp-1')
    await submitReview(deps, review.reviewId, 'approved')

    const result = await gate(deps, { root: '/tmp/repo', fingerprint: 'fp-2-different' })

    expect(result.decision).toBe('deny')
    expect(result.reason).toMatch(/approved at snapshot 1/)
    expect(result.reason).toMatch(/changed since/)
  })
})

describe('release', () => {
  it('refuses while an approval has not been used by a commit', async () => {
    const review = await reviewAt('/tmp/repo', 'fp-1')
    await submitReview(deps, review.reviewId, 'approved')

    const result = await release(deps, review.reviewId, false)

    expect(result.released).toBe(false)
    expect(result.reason).toMatch(/no commit has used that approval/)
    expect(await ctx.db.selectFrom('review').selectAll().execute()).toHaveLength(1)
  })

  it('releases once the gate has stamped the approval', async () => {
    const review = await reviewAt('/tmp/repo', 'fp-1')
    await submitReview(deps, review.reviewId, 'approved')
    await gate(deps, { root: '/tmp/repo', fingerprint: fingerprintFor('fp-1') })

    expect(await release(deps, review.reviewId, false)).toEqual({ released: true })
    expect(await ctx.db.selectFrom('review').selectAll().execute()).toHaveLength(0)
  })

  it('releases an unapproved review with nothing to guard', async () => {
    const review = await reviewAt('/tmp/repo', 'fp-1')

    expect(await release(deps, review.reviewId, false)).toEqual({ released: true })
  })

  it('abandons an approved review when force says so', async () => {
    const review = await reviewAt('/tmp/repo', 'fp-1')
    await submitReview(deps, review.reviewId, 'approved')

    expect(await release(deps, review.reviewId, true)).toEqual({ released: true })
  })

  it('takes the review data with it and collects the orphaned bytes', async () => {
    const review = await reviewAt('/tmp/repo', 'fp-1')
    expect(await ctx.db.selectFrom('blob').selectAll().execute()).toHaveLength(1)

    await release(deps, review.reviewId, true)

    for (const table of ['source', 'snapshot', 'file_change', 'blob'] as const) {
      expect(await ctx.db.selectFrom(table).selectAll().execute(), table).toHaveLength(0)
    }
  })

  it('keeps bytes another review still references', async () => {
    const first = await reviewAt('/tmp/repo-a', 'fp-1', 'first')
    await reviewAt('/tmp/repo-b', 'fp-2', 'second')

    await release(deps, first.reviewId, true)

    // Both reviews uploaded identical content, so the blob is shared.
    expect(await ctx.db.selectFrom('blob').selectAll().execute()).toHaveLength(1)
  })
})

describe('sweepOrphanBlobs', () => {
  it('leaves referenced bytes alone', async () => {
    await reviewAt('/tmp/repo', 'fp-1')

    expect(await sweepOrphanBlobs(ctx.db)).toBe(0)
    expect(await ctx.db.selectFrom('blob').selectAll().execute()).toHaveLength(1)
  })

  it('collects bytes uploaded for a snapshot that never arrived', async () => {
    const content = new TextEncoder().encode('uploaded then abandoned')
    await putBlob(deps, sha256(content), content)

    expect(await sweepOrphanBlobs(ctx.db)).toBe(1)
  })
})
