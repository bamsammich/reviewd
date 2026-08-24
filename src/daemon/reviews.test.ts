import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve, type ResolvedConfig } from './config.js'
import { tempDatabase, type TempDatabase } from './db/testing.js'
import {
  createReview,
  createSnapshot,
  listReviews,
  missingBlobs,
  putBlob,
  readBlob,
  ReviewError,
  sha256,
  summarize,
  wholeReviewFingerprint,
  type Deps,
} from './reviews.js'

let ctx: TempDatabase
let deps: Deps
let config: ResolvedConfig

beforeEach(async () => {
  ctx = await tempDatabase()
  config = resolve(configSchema.parse({ public_url: 'https://mac.tailnet-name.ts.net' }), {
    configPath: '/tmp/reviewd-test.json',
    bindPublic: false,
  })
  deps = { db: ctx.db, config }
})

afterEach(async () => {
  await ctx.close()
})

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

async function upload(text: string): Promise<string> {
  const content = bytes(text)
  const id = sha256(content)
  await putBlob(deps, id, content)
  return id
}

/** Two roots, because multi-root is the case that shapes the schema. */
async function twoRootReview() {
  return createReview(deps, {
    title: 'dotfiles and claude config',
    sources: [
      { path: '/tmp/dotfiles', base: 'HEAD', includeUntracked: true },
      { path: '/tmp/claude', base: 'HEAD', label: '~/.claude', includeUntracked: true },
    ],
    createdBy: 'test-session',
    notify: false,
  })
}

describe('createReview', () => {
  it('spans several roots in one review', async () => {
    const review = await twoRootReview()

    expect(review.sources).toHaveLength(2)
    expect(review.sources.map((s) => s.rootPath)).toEqual(['/tmp/dotfiles', '/tmp/claude'])
    expect(review.status).toBe('open')
    expect(review.snapshotSeq).toBe(0)
  })

  it('labels a source by its directory name when none is given', async () => {
    const review = await twoRootReview()

    expect(review.sources[0]?.label).toBe('dotfiles')
    expect(review.sources[1]?.label).toBe('~/.claude')
  })

  it('treats a source with no base ref as a plain file set', async () => {
    const review = await createReview(deps, {
      title: 'scratch',
      sources: [{ path: '/tmp/scratch', includeUntracked: true }],
      createdBy: '',
      notify: false,
    })

    expect(review.sources[0]?.vcs).toBe('none')
    expect(review.sources[0]?.baseRef).toBeNull()
  })

  it('builds the url from public_url, never from a request address', async () => {
    const review = await twoRootReview()
    expect(review.url).toBe(`https://mac.tailnet-name.ts.net/r/${review.reviewId}`)
  })
})

describe('blobs', () => {
  it('stores content under its own hash and dedupes a second write', async () => {
    const content = bytes('hello')
    const id = sha256(content)

    expect(await putBlob(deps, id, content)).toEqual({ stored: true })
    expect(await putBlob(deps, id, content)).toEqual({ stored: false })

    const read = await readBlob(ctx.db, id)
    expect(read?.bytes.toString('utf8')).toBe('hello')
  })

  it('refuses content that does not hash to the id it was filed under', async () => {
    // A client that computed the hash wrong would otherwise poison every later
    // snapshot that dedupes against this id.
    await expect(putBlob(deps, sha256(bytes('one')), bytes('two'))).rejects.toThrow(
      /does not match its content/,
    )
  })

  it('refuses content over the size limit', async () => {
    const small = resolve(configSchema.parse({ limits: { max_blob_bytes: 4 } }), {
      configPath: '/tmp/reviewd-test.json',
      bindPublic: false,
    })
    const content = bytes('too much')

    await expect(putBlob({ db: ctx.db, config: small }, sha256(content), content)).rejects.toThrow(
      /over the 4 limit/,
    )
  })

  it('reports which ids are missing so an upload sends only what changed', async () => {
    const present = await upload('present')
    const absent = sha256(bytes('absent'))

    expect(await missingBlobs(ctx.db, [present, absent])).toEqual([absent])
    expect(await missingBlobs(ctx.db, [])).toEqual([])
  })
})

describe('createSnapshot', () => {
  it('numbers snapshots from one and counts the files', async () => {
    const review = await twoRootReview()
    const blobId = await upload('const x = 1\n')

    const result = await createSnapshot(deps, review.reviewId, {
      fingerprints: {
        [review.sources[0]!.id]: 'fp-dotfiles-1',
        [review.sources[1]!.id]: 'fp-claude-1',
      },
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

    expect(result.seq).toBe(1)
    expect(result.fileCount).toBe(1)
    expect(result.url).toContain(review.reviewId)

    const second = await createSnapshot(deps, review.reviewId, {
      fingerprints: {
        [review.sources[0]!.id]: 'fp-dotfiles-2',
        [review.sources[1]!.id]: 'fp-claude-1',
      },
      files: [],
    })
    expect(second.seq).toBe(2)
  })

  it('keeps a fingerprint per source, because the gate asks about one root', async () => {
    const review = await twoRootReview()

    await createSnapshot(deps, review.reviewId, {
      fingerprints: {
        [review.sources[0]!.id]: 'fp-dotfiles',
        [review.sources[1]!.id]: 'fp-claude',
      },
      files: [],
    })

    const rows = await ctx.db.selectFrom('snapshot_source').selectAll().execute()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.fingerprint).sort()).toEqual(['fp-claude', 'fp-dotfiles'])
  })

  it('refuses a manifest missing a fingerprint for one of its roots', async () => {
    const review = await twoRootReview()

    await expect(
      createSnapshot(deps, review.reviewId, {
        fingerprints: { [review.sources[0]!.id]: 'only-one' },
        files: [],
      }),
    ).rejects.toThrow(/no fingerprint for source/)
  })

  it('refuses a manifest referencing bytes nobody uploaded', async () => {
    // Accepting it would leave a review that renders as empty files.
    const review = await twoRootReview()

    await expect(
      createSnapshot(deps, review.reviewId, {
        fingerprints: {
          [review.sources[0]!.id]: 'fp',
          [review.sources[1]!.id]: 'fp',
        },
        files: [
          {
            sourceId: review.sources[0]!.id,
            path: 'src/a.ts',
            changeType: 'added',
            oldPath: null,
            oldBlobId: null,
            newBlobId: sha256(bytes('never uploaded')),
            isBinary: false,
            truncated: false,
          },
        ],
      }),
    ).rejects.toThrow(/not uploaded/)
  })

  it('refuses a file naming a source from another review', async () => {
    const mine = await twoRootReview()
    const theirs = await createReview(deps, {
      title: 'other',
      sources: [{ path: '/tmp/other', base: 'HEAD', includeUntracked: true }],
      createdBy: '',
      notify: false,
    })

    await expect(
      createSnapshot(deps, mine.reviewId, {
        fingerprints: {
          [mine.sources[0]!.id]: 'fp',
          [mine.sources[1]!.id]: 'fp',
        },
        files: [
          {
            sourceId: theirs.sources[0]!.id,
            path: 'src/a.ts',
            changeType: 'added',
            oldPath: null,
            oldBlobId: null,
            newBlobId: null,
            isBinary: false,
            truncated: false,
          },
        ],
      }),
    ).rejects.toThrow(/not in this review/)
  })

  it('supersedes any approval, which is the gate re-arming', async () => {
    const review = await twoRootReview()
    const fingerprints = {
      [review.sources[0]!.id]: 'fp-1',
      [review.sources[1]!.id]: 'fp-1',
    }

    await createSnapshot(deps, review.reviewId, { fingerprints, files: [] })

    const snapshot = await ctx.db.selectFrom('snapshot').selectAll().executeTakeFirstOrThrow()
    await ctx.db
      .insertInto('approval')
      .values({
        id: 'approval-1',
        review_id: review.reviewId,
        snapshot_id: snapshot.id,
        source_id: review.sources[0]!.id,
        root_path: '/tmp/dotfiles',
        fingerprint: 'fp-1',
        approved_at: Date.now(),
        consumed_at: null,
      })
      .execute()

    await createSnapshot(deps, review.reviewId, {
      fingerprints: {
        [review.sources[0]!.id]: 'fp-2',
        [review.sources[1]!.id]: 'fp-1',
      },
      files: [],
    })

    expect(await ctx.db.selectFrom('approval').selectAll().execute()).toHaveLength(0)
  })

  it('refuses a snapshot for a review that does not exist', async () => {
    await expect(
      createSnapshot(deps, 'nope', { fingerprints: {}, files: [] }),
    ).rejects.toBeInstanceOf(ReviewError)
  })
})

describe('wholeReviewFingerprint', () => {
  it('does not depend on the order sources arrived in', () => {
    const a = wholeReviewFingerprint({ one: 'x', two: 'y' })
    const b = wholeReviewFingerprint({ two: 'y', one: 'x' })

    expect(a).toBe(b)
  })

  it('changes when any source changes', () => {
    const before = wholeReviewFingerprint({ one: 'x', two: 'y' })
    const after = wholeReviewFingerprint({ one: 'x', two: 'z' })

    expect(after).not.toBe(before)
  })
})

describe('listReviews', () => {
  it('filters by the root a caller cares about', async () => {
    await twoRootReview()
    await createReview(deps, {
      title: 'unrelated',
      sources: [{ path: '/tmp/elsewhere', base: 'HEAD', includeUntracked: true }],
      createdBy: '',
      notify: false,
    })

    const here = await listReviews(deps, { rootPath: '/tmp/claude' })
    expect(here).toHaveLength(1)
    expect(here[0]?.title).toBe('dotfiles and claude config')

    expect(await listReviews(deps, { rootPath: '/tmp/nothing-here' })).toEqual([])
  })

  it('filters by status', async () => {
    await twoRootReview()
    expect(await listReviews(deps, { status: 'open' })).toHaveLength(1)
    expect(await listReviews(deps, { status: 'approved' })).toHaveLength(0)
  })
})

describe('summarize', () => {
  it('reports 404 for a review that does not exist', async () => {
    await expect(summarize(deps, 'nope')).rejects.toMatchObject({ status: 404 })
  })
})
