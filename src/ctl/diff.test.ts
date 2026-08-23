import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diffFileSet, diffGitSource, looksBinary, parseRawDiff, sha256 } from './diff.js'
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
      { status: 'M', oldSha: 'aaa', newSha: 'bbb', path: 'src/a.ts' },
    ])
  })

  it('reads a rename, which carries two paths', () => {
    const raw = ':100644 100644 aaa bbb R100\0old.ts\0new.ts\0'
    expect(parseRawDiff(raw)).toEqual([
      { status: 'R100', oldSha: 'aaa', newSha: 'bbb', path: 'new.ts', oldPath: 'old.ts' },
    ])
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

describe('sha256', () => {
  it('is the address content is stored under', () => {
    expect(sha256(new TextEncoder().encode('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })
})
