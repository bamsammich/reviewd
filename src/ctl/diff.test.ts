import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  commitInfo,
  diffCommitRange,
  diffOneCommit,
  diffPushRange,
  diffFileSet,
  diffGitSource,
  diffSource,
  pushRange,
  unpushedCommits,
  looksBinary,
  parseRawDiff,
  sha256,
} from './diff.js'
import { tempRepo, type TempRepo } from './testing.js'

let repo: TempRepo

beforeEach(() => {
  repo = tempRepo()
  repo.write('src/a.ts', 'const a = 1\n')
  repo.write('src/b.ts', 'const b = 1\n')
  repo.commit('initial')
})

afterEach(() => {
  repo.cleanup()
})

function source(root: string, baseRef?: string) {
  return { id: 'source-1', rootPath: root, baseRef }
}

function text(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : ''
}

describe('looksBinary', () => {
  it('calls a NUL byte binary and plain text not', () => {
    expect(looksBinary(new Uint8Array([0x68, 0x69, 0x00]))).toBe(true)
    expect(looksBinary(new TextEncoder().encode('hello\nworld\n'))).toBe(false)
  })
})

describe('parseRawDiff', () => {
  it('reads a modification', () => {
    const raw = ':100644 100644 aaa bbb M\0src/a.ts\0'
    expect(parseRawDiff(raw)).toEqual([
      {
        status: 'M',
        oldMode: '100644',
        newMode: '100644',
        oldSha: 'aaa',
        newSha: 'bbb',
        path: 'src/a.ts',
      },
    ])
  })

  it('reads a rename, which carries two paths', () => {
    const raw = ':100644 100644 aaa bbb R100\0old.ts\0new.ts\0'
    expect(parseRawDiff(raw)).toEqual([
      {
        status: 'R100',
        oldMode: '100644',
        newMode: '100644',
        oldSha: 'aaa',
        newSha: 'bbb',
        path: 'new.ts',
        oldPath: 'old.ts',
      },
    ])
  })

  /**
   * The mode is the only thing separating a submodule from a file, and dropping
   * it is what sent a commit sha to `cat-file blob` and failed the whole diff.
   */
  it('keeps the modes, so a gitlink can be told from a file', () => {
    const raw = ':160000 160000 aaa bbb M\0vendor/lib\0'
    expect(parseRawDiff(raw)[0]).toMatchObject({ oldMode: '160000', newMode: '160000' })
  })

  it('reads several records in one pass', () => {
    const raw = ':100644 100644 a b M\0one.ts\0:000000 100644 0000000 c A\0two.ts\0'
    const changes = parseRawDiff(raw)

    expect(changes).toHaveLength(2)
    expect(changes[1]?.path).toBe('two.ts')
  })

  it('survives a path holding a space', () => {
    const raw = ':100644 100644 a b M\0src/a file.ts\0'
    expect(parseRawDiff(raw)[0]?.path).toBe('src/a file.ts')
  })
})

describe('diffGitSource', () => {
  it('finds a modification and carries both sides', async () => {
    repo.write('src/a.ts', 'const a = 2\n')

    const diff = await diffGitSource(source(repo.root))

    expect(diff.files).toHaveLength(1)
    const file = diff.files[0]!
    expect(file.path).toBe('src/a.ts')
    expect(file.changeType).toBe('modified')
    expect(text(diff.blobs.get(file.oldBlobId!))).toBe('const a = 1\n')
    expect(text(diff.blobs.get(file.newBlobId!))).toBe('const a = 2\n')
  })

  it('finds an untracked file, which is the case a plain diff misses', async () => {
    repo.write('src/new.ts', 'const n = 1\n')

    const diff = await diffGitSource(source(repo.root))

    expect(diff.files.map((f) => f.path)).toEqual(['src/new.ts'])
    expect(diff.files[0]?.changeType).toBe('added')
    expect(diff.files[0]?.oldBlobId).toBeNull()
  })

  it('finds a deletion and keeps the old side', async () => {
    repo.run('rm', '-q', 'src/b.ts')

    const diff = await diffGitSource(source(repo.root))

    expect(diff.files[0]?.changeType).toBe('deleted')
    expect(diff.files[0]?.newBlobId).toBeNull()
    expect(text(diff.blobs.get(diff.files[0]!.oldBlobId!))).toBe('const b = 1\n')
  })

  it('finds a rename and names where it came from', async () => {
    repo.run('mv', 'src/b.ts', 'src/renamed.ts')

    const diff = await diffGitSource(source(repo.root))
    const rename = diff.files.find((f) => f.changeType === 'renamed')

    expect(rename?.path).toBe('src/renamed.ts')
    expect(rename?.oldPath).toBe('src/b.ts')
  })

  it('describes binary content rather than storing it', async () => {
    writeFileSync(join(repo.root, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff]))

    const diff = await diffGitSource(source(repo.root))
    const binary = diff.files.find((f) => f.path === 'logo.png')

    expect(binary?.isBinary).toBe(true)
    expect(binary?.changeType).toBe('binary')
    expect(binary?.newBlobId).toBeNull()
    expect(diff.blobs.size).toBe(0)
  })

  it('marks oversize content truncated rather than uploading it', async () => {
    repo.write('big.txt', 'x'.repeat(100))

    const diff = await diffGitSource(source(repo.root), {
      maxBlobBytes: 10,
      maxFilesPerSnapshot: 100,
    })
    const big = diff.files.find((f) => f.path === 'big.txt')

    expect(big?.truncated).toBe(true)
    expect(big?.newBlobId).toBeNull()
  })

  it('refuses a change set over the file limit', async () => {
    for (let i = 0; i < 5; i += 1) repo.write(`f${i}.ts`, `const f = ${i}\n`)

    await expect(
      diffGitSource(source(repo.root), { maxBlobBytes: 1024, maxFilesPerSnapshot: 3 }),
    ).rejects.toThrow(/over the 3 limit/)
  })

  it('dedupes identical content across files', async () => {
    repo.write('one.ts', 'same content\n')
    repo.write('two.ts', 'same content\n')

    const diff = await diffGitSource(source(repo.root))

    expect(diff.files).toHaveLength(2)
    // Content-addressed, so both files point at one blob.
    expect(diff.blobs.size).toBe(1)
  })

  it('reads nothing from a clean tree', async () => {
    const diff = await diffGitSource(source(repo.root))

    expect(diff.files).toEqual([])
    expect(diff.blobs.size).toBe(0)
  })

  it('diffs against a named base rather than HEAD', async () => {
    repo.run('checkout', '-q', '-b', 'feature')
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('on the branch')

    const diff = await diffGitSource(source(repo.root, 'main'))

    expect(diff.files.map((f) => f.path)).toEqual(['src/a.ts'])
  })

  it('moves the fingerprint when content moves and holds it otherwise', async () => {
    const before = (await diffGitSource(source(repo.root))).fingerprint

    repo.write('src/a.ts', 'const a = 2\n')
    const after = (await diffGitSource(source(repo.root))).fingerprint

    expect(after).not.toBe(before)
    expect((await diffGitSource(source(repo.root))).fingerprint).toBe(after)
  })
})

/**
 * A submodule entry is a gitlink: mode 160000, holding a commit sha from the
 * submodule's own object database. Reading it as a blob fails with "Not a valid
 * object name" and took the whole diff with it, so a repository with submodules
 * could not be reviewed at all.
 */
describe('diffGitSource with a submodule', () => {
  let inner: TempRepo

  beforeEach(() => {
    inner = tempRepo()
  })

  afterEach(() => {
    inner.cleanup()
  })

  it('diffs a moved pointer rather than failing to read it as a blob', async () => {
    const { first } = repo.submodule('vendor/lib', inner)
    repo.run('-C', 'vendor/lib', 'checkout', '-q', first)

    const diff = await diffGitSource(source(repo.root))
    const change = diff.files.find((f) => f.path === 'vendor/lib')

    expect(change).toBeDefined()
    expect(change?.changeType).toBe('modified')
  })

  /** The same line `git diff` renders, so the reviewer reads what git says. */
  it('shows the pointer on both sides the way git writes it', async () => {
    const { first, second } = repo.submodule('vendor/lib', inner)
    repo.run('-C', 'vendor/lib', 'checkout', '-q', first)

    const diff = await diffGitSource(source(repo.root))
    const change = diff.files.find((f) => f.path === 'vendor/lib')

    expect(text(diff.blobs.get(change?.oldBlobId ?? ''))).toBe(`Subproject commit ${second}\n`)
    expect(text(diff.blobs.get(change?.newBlobId ?? ''))).toBe(`Subproject commit ${first}\n`)
  })

  /**
   * A moved pointer changes what the superproject builds, so it has to re-arm
   * the gate rather than ride along under the approval given before it.
   */
  it('moves the fingerprint when the pointer moves', async () => {
    const { first, second } = repo.submodule('vendor/lib', inner)
    const clean = (await diffGitSource(source(repo.root))).fingerprint

    repo.run('-C', 'vendor/lib', 'checkout', '-q', first)
    const moved = (await diffGitSource(source(repo.root))).fingerprint

    repo.run('-C', 'vendor/lib', 'checkout', '-q', second)
    const back = (await diffGitSource(source(repo.root))).fingerprint

    expect(moved).not.toBe(clean)
    expect(back).toBe(clean)
  })

  it('reads a repository whose submodule has not moved as unchanged', async () => {
    repo.submodule('vendor/lib', inner)
    expect((await diffGitSource(source(repo.root))).files).toEqual([])
  })

  it('handles an added submodule alongside ordinary files', async () => {
    repo.submodule('vendor/lib', inner)
    repo.write('src/a.ts', 'const a = 2\n')
    repo.run('-C', 'vendor/lib', 'checkout', '-q', 'HEAD~1')

    const diff = await diffGitSource(source(repo.root))

    expect(diff.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'vendor/lib'])
  })
})

describe('diffFileSet', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reviewd-files-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads every file as an addition', async () => {
    writeFileSync(join(dir, 'one.txt'), 'first\n')
    mkdirSync(join(dir, 'nested'))
    writeFileSync(join(dir, 'nested', 'two.txt'), 'second\n')

    const diff = await diffFileSet(source(dir))

    expect(diff.files.map((f) => f.path).sort()).toEqual(['nested/two.txt', 'one.txt'])
    expect(diff.files.every((f) => f.changeType === 'added')).toBe(true)
  })

  it('skips directories nothing wants read', async () => {
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules', 'huge.js'), 'x')
    writeFileSync(join(dir, 'real.txt'), 'content\n')

    const diff = await diffFileSet(source(dir))

    expect(diff.files.map((f) => f.path)).toEqual(['real.txt'])
  })

  it('moves the fingerprint when a file changes', async () => {
    writeFileSync(join(dir, 'one.txt'), 'first\n')
    const before = (await diffFileSet(source(dir))).fingerprint

    writeFileSync(join(dir, 'one.txt'), 'changed\n')

    expect((await diffFileSet(source(dir))).fingerprint).not.toBe(before)
  })

  it('does not depend on the order the walk returned files in', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    writeFileSync(join(dir, 'b.txt'), 'b\n')

    const first = (await diffFileSet(source(dir))).fingerprint
    const second = (await diffFileSet(source(dir))).fingerprint

    expect(second).toBe(first)
  })
})

describe('diffSource', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reviewd-source-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('compares a repository against HEAD when no base was given', async () => {
    repo.write('src/a.ts', 'const a = 2\n')

    const diff = await diffSource(source(repo.root))

    // The bug this covers returned every tracked file as an addition.
    expect(diff.files.map((f) => f.path)).toEqual(['src/a.ts'])
    expect(diff.files[0]?.changeType).toBe('modified')
  })

  it('reads a directory under no version control as a file set', async () => {
    writeFileSync(join(dir, 'one.txt'), 'first\n')

    const diff = await diffSource(source(dir))

    expect(diff.files.map((f) => f.path)).toEqual(['one.txt'])
    expect(diff.files[0]?.changeType).toBe('added')
  })

  it('reads a subdirectory of a repository as a file set, not the whole repo', async () => {
    repo.write('outside.ts', 'const outside = 1\n')

    const diff = await diffSource(source(join(repo.root, 'src')))

    // git add -A would have staged outside.ts too. Nothing above src is here.
    expect(diff.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('reads a linked worktree as a repository', async () => {
    // A worktree's .git is a pointer file, not a directory. git itself does not
    // care, and neither should the detection: rev-parse answers the same.
    const tree = repo.worktree('feature')
    writeFileSync(join(tree, 'src/a.ts'), 'const a = 2\n')

    const diff = await diffSource(source(tree))

    expect(diff.files.map((f) => f.path)).toEqual(['src/a.ts'])
    expect(diff.files[0]?.changeType).toBe('modified')
  })

  it('still honours a base that was given', async () => {
    repo.run('checkout', '-q', '-b', 'work')
    repo.write('src/c.ts', 'const c = 1\n')
    repo.commit('add c')

    const diff = await diffSource(source(repo.root, 'main'))

    expect(diff.files.map((f) => f.path)).toEqual(['src/c.ts'])
  })

  it('treats a repository with no commits as all additions', async () => {
    const fresh = tempRepo()
    try {
      fresh.write('new.ts', 'const n = 1\n')

      const diff = await diffSource(source(fresh.root))

      expect(diff.files.map((f) => f.path)).toEqual(['new.ts'])
      expect(diff.files[0]?.changeType).toBe('added')
    } finally {
      fresh.cleanup()
    }
  })
})

describe('sha256', () => {
  it('is the address content is stored under', () => {
    expect(sha256(new TextEncoder().encode('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })
})

/**
 * What a push would carry.
 *
 * A remote ref is created by hand rather than by pushing anywhere: what
 * decides the range is which commits a `refs/remotes/*` ref reaches, and a
 * real remote adds network and a second repository without changing the
 * question.
 */
describe('the range a push would carry', () => {
  /** Marks everything up to HEAD as already on a remote. */
  const published = () => repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD')

  it('lists the commits no remote has yet, newest first', async () => {
    published()
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('second')
    repo.write('src/a.ts', 'const a = 3\n')
    repo.commit('third')

    const commits = await unpushedCommits(repo.root)
    const messages = commits.map((sha) => repo.run('log', '-1', '--format=%s', sha).trim())

    expect(messages).toEqual(['third', 'second'])
  })

  it('has nothing to carry when a remote already has HEAD', async () => {
    published()

    expect(await pushRange(repo.root)).toBeNull()
  })

  // The first push of a repository nobody has pushed: every commit is new, and
  // the range starts before the first one rather than failing to find a parent.
  it('covers every commit when no remote has anything', async () => {
    const range = await pushRange(repo.root)
    const diff = await diffCommitRange(source(repo.root), range!)

    expect(range?.commits).toHaveLength(1)
    expect(diff.files.map((file) => file.path).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(diff.files.every((file) => file.changeType === 'added')).toBe(true)
  })

  it('describes the net change across several commits, not each one', async () => {
    published()
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('second')
    repo.write('src/a.ts', 'const a = 3\n')
    repo.write('src/c.ts', 'const c = 1\n')
    repo.commit('third')

    const range = await pushRange(repo.root)
    const diff = await diffCommitRange(source(repo.root), range!)

    expect(diff.files.map((file) => file.path).sort()).toEqual(['src/a.ts', 'src/c.ts'])
    expect(diff.files.find((file) => file.path === 'src/c.ts')?.changeType).toBe('added')
  })

  // Touched and put back, so the push carries nothing about it and neither
  // should the review.
  it('leaves out a file a later commit restored', async () => {
    published()
    repo.write('src/a.ts', 'const a = 999\n')
    repo.commit('break it')
    repo.write('src/a.ts', 'const a = 1\n')
    repo.commit('put it back')

    const range = await pushRange(repo.root)
    const diff = await diffCommitRange(source(repo.root), range!)

    expect(diff.files).toEqual([])
  })

  /**
   * The difference from diffGitSource, and the reason this is a separate
   * function rather than a flag on that one: a push carries commits, and an
   * edit sitting in the working tree is not being pushed.
   */
  it('ignores an uncommitted edit, which no push would carry', async () => {
    published()
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('second')
    repo.write('src/b.ts', 'not committed\n')

    const range = await pushRange(repo.root)
    const diff = await diffCommitRange(source(repo.root), range!)

    expect(diff.files.map((file) => file.path)).toEqual(['src/a.ts'])
  })

  // Same bytes, same approval. A rebase that changed no file produces the same
  // change set, so an approval already given still covers the push.
  it('gives a rebase that changed nothing the same fingerprint', async () => {
    published()
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('second')

    const before = await diffCommitRange(source(repo.root), (await pushRange(repo.root))!)
    repo.run('commit', '--amend', '--no-edit', '--date=Wed Feb 16 14:00 2028 +0100')
    const after = await diffCommitRange(source(repo.root), (await pushRange(repo.root))!)

    expect(after.fingerprint).toBe(before.fingerprint)
  })
})

/**
 * What each commit of a push says about itself, and what each one did.
 *
 * The daemon cannot ask git any of this, so the client reads it and uploads
 * it. These cover the reading.
 */
describe('reading the commits of a push', () => {
  const published = () => repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD')

  it('reads subject, author and date for each commit', async () => {
    published()
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('second commit')

    const range = (await pushRange(repo.root))!
    const [info] = await commitInfo(repo.root, range.commits)

    expect(info?.sha).toBe(range.commits[0])
    expect(info?.subject).toBe('second commit')
    expect(info?.author).toBe('test')
    expect(info?.committedAt).toBeGreaterThan(0)
  })

  // A subject with a field separator in it cannot happen, but a subject with
  // the shapes people actually use can: quotes, colons, and a trailing space.
  it('survives a subject full of punctuation', async () => {
    published()
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('fix: "quoted", and a | pipe')

    const range = (await pushRange(repo.root))!
    const [info] = await commitInfo(repo.root, range.commits)

    expect(info?.subject).toBe('fix: "quoted", and a | pipe')
  })

  it('reads every commit in one call, oldest last', async () => {
    published()
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('older')
    repo.write('src/a.ts', 'const a = 3\n')
    repo.commit('newer')

    const range = (await pushRange(repo.root))!
    const infos = await commitInfo(repo.root, range.commits)

    expect(infos.map((i) => i.subject)).toEqual(['newer', 'older'])
  })

  it('says nothing about no commits rather than asking git about none', async () => {
    expect(await commitInfo(repo.root, [])).toEqual([])
  })
})

describe('what one commit changed', () => {
  const published = () => repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD')

  it('describes only that commit, not the range around it', async () => {
    published()
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('touch a')
    repo.write('src/b.ts', 'const b = 2\n')
    repo.commit('touch b')

    const range = (await pushRange(repo.root))!
    const newest = range.commits[0] as string

    const diff = await diffOneCommit(source(repo.root), newest)

    expect(diff.files.map((f) => f.path)).toEqual(['src/b.ts'])
  })

  // The state a file passed through, which the combined diff never shows: the
  // whole push leaves src/a.ts at 3, and the first commit left it at 2.
  it('shows the intermediate state a later commit replaced', async () => {
    published()
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('to two')
    repo.write('src/a.ts', 'const a = 3\n')
    repo.commit('to three')

    const range = (await pushRange(repo.root))!
    const oldest = range.commits[range.commits.length - 1] as string

    const first = await diffOneCommit(source(repo.root), oldest)
    const whole = await diffCommitRange(source(repo.root), range)

    expect(first.files).toHaveLength(1)
    expect(whole.files).toHaveLength(1)
    expect(first.fingerprint).not.toBe(whole.fingerprint)
  })

  it('reads a first commit as every file added', async () => {
    const range = (await pushRange(repo.root))!
    const only = range.commits[range.commits.length - 1] as string

    const diff = await diffOneCommit(source(repo.root), only)

    expect(diff.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(diff.files.every((f) => f.changeType === 'added')).toBe(true)
  })

  // A merge is read against its first parent, which is what the other side's
  // own commits already cover.
  it('reads a merge against the branch it was merged into', async () => {
    published()
    repo.run('checkout', '-q', '-b', 'side')
    repo.write('src/c.ts', 'const c = 1\n')
    repo.commit('on the side')
    repo.run('checkout', '-q', 'main')
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('on main')
    repo.run('merge', '--no-ff', '-m', 'merge side', 'side')

    const head = repo.run('rev-parse', 'HEAD').trim()
    const diff = await diffOneCommit(source(repo.root), head)

    expect(diff.files.map((f) => f.path)).toEqual(['src/c.ts'])
  })
})

describe('reading a push as its commits', () => {
  const published = () => repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD')

  it('gives the combined change set and the commits it divides into', async () => {
    published()
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('to two')
    repo.write('src/a.ts', 'const a = 3\n')
    repo.commit('to three')

    const push = (await diffPushRange(source(repo.root)))!

    // Oldest first, which is the order they were written and the order the
    // ordinal the daemon assigns has to mean.
    expect(push.commits.map((c) => c.subject)).toEqual(['to two', 'to three'])
    expect(push.commits.every((c) => c.sourceId === 'source-1')).toBe(true)

    // One file in the combined reading, at its final state; each commit holds
    // the state it left behind.
    expect(push.diff.files.map((f) => f.path)).toEqual(['src/a.ts'])
    const combined = push.diff.files[0]!.newBlobId as string
    const first = push.commits[0]!.files[0]!.newBlobId as string
    expect(first).not.toBe(combined)
    expect(text(push.diff.blobs.get(first))).toBe('const a = 2\n')
  })

  it('carries the bytes of a state no combined diff holds', async () => {
    // The blobs the caller uploads come from one map, so a commit's own sides
    // travel with the push rather than being asked for later.
    published()
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('to two')
    repo.write('src/a.ts', 'const a = 3\n')
    repo.commit('to three')

    const push = (await diffPushRange(source(repo.root)))!
    const sides = push.commits.flatMap((c) =>
      c.files.flatMap((f) => [f.oldBlobId, f.newBlobId].filter((id) => id !== null)),
    )

    expect(sides.length).toBeGreaterThan(0)
    for (const id of sides) expect(push.diff.blobs.has(id as string)).toBe(true)
  })

  it('says nothing when every commit is already on a remote', async () => {
    published()
    expect(await diffPushRange(source(repo.root))).toBeNull()
  })

  it('says nothing about a directory that is not a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'reviewd-plain-'))
    writeFileSync(join(plain, 'notes.md'), 'nothing to push\n')

    try {
      expect(await diffPushRange(source(plain))).toBeNull()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('reads a merge as what it merged in, and the rest as itself', async () => {
    published()
    repo.run('checkout', '-q', '-b', 'side')
    repo.write('src/c.ts', 'const c = 1\n')
    repo.commit('on the side')
    repo.run('checkout', '-q', 'main')
    repo.write('src/a.ts', 'const a = 2\n')
    repo.commit('on main')
    repo.run('merge', '--no-ff', '-m', 'merge side', 'side')

    const push = (await diffPushRange(source(repo.root)))!
    const merge = push.commits.find((c) => c.subject === 'merge side')!

    expect(merge.files.map((f) => f.path)).toEqual(['src/c.ts'])
    expect(push.diff.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/c.ts'])
  })
})

/**
 * A repository nobody has committed to yet.
 *
 * `rev-list HEAD` treats a missing HEAD as an error rather than as an empty
 * answer, so a fresh `git init` under push gating failed the whole review on a
 * git error instead of reading as nothing to push.
 */
describe('a repository with no commits', () => {
  let fresh: TempRepo

  beforeEach(() => {
    fresh = tempRepo()
    fresh.write('a.ts', 'const a = 1\n')
  })

  afterEach(() => {
    fresh.cleanup()
  })

  it('has nothing unpushed rather than an error', async () => {
    expect(await unpushedCommits(fresh.root)).toEqual([])
  })

  it('carries no push', async () => {
    expect(await pushRange(fresh.root)).toBeNull()
  })

  // Null is what sends the caller to the working tree, which is the only
  // reading a repository with no commits has.
  it('reads as no push range, so the working tree is what gets reviewed', async () => {
    expect(await diffPushRange(source(fresh.root))).toBeNull()
  })
})
