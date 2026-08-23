import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diffAgainstHead, fingerprint, gitDir, repoRoot } from './git.js'
import { tempRepo, type TempRepo } from './testing.js'

let repo: TempRepo

beforeEach(() => {
  repo = tempRepo()
  repo.write('src/a.ts', 'const a = 1\n')
  repo.commit('initial')
})

afterEach(() => {
  repo.cleanup()
})

describe('repoRoot', () => {
  it('finds the root from inside the tree', async () => {
    const found = await repoRoot(join(repo.root, 'src'))
    // macOS hands out /var, which resolves through a symlink to /private/var.
    expect(found).toMatch(/reviewctl-repo-/)
  })

  it('answers null outside a repository', async () => {
    expect(await repoRoot('/')).toBeNull()
  })
})

describe('fingerprint', () => {
  it('is stable while nothing changes', async () => {
    repo.write('src/a.ts', 'const a = 2\n')

    expect(await fingerprint(repo.root)).toBe(await fingerprint(repo.root))
  })

  it('is empty-diff stable on a clean tree', async () => {
    const clean = await diffAgainstHead(repo.root)
    expect(clean).toBe('')
  })

  it('changes when content changes', async () => {
    const before = await fingerprint(repo.root)
    repo.write('src/a.ts', 'const a = 2\n')

    expect(await fingerprint(repo.root)).not.toBe(before)
  })

  it('does not move when the change is staged', async () => {
    // The bug this exists to prevent: staging shifting the fingerprint would
    // invalidate an approval at the moment of the commit it had just cleared.
    repo.write('src/a.ts', 'const a = 2\n')
    const unstaged = await fingerprint(repo.root)

    repo.run('add', 'src/a.ts')
    const staged = await fingerprint(repo.root)

    expect(staged).toBe(unstaged)
  })

  it('covers untracked files the same as tracked ones', async () => {
    const before = await fingerprint(repo.root)
    repo.write('src/brand-new.ts', 'const n = 1\n')

    expect(await fingerprint(repo.root)).not.toBe(before)
  })

  it('gives a half-staged tree the same answer as a fully staged one', async () => {
    repo.write('src/a.ts', 'const a = 2\n')
    repo.write('src/b.ts', 'const b = 1\n')

    repo.run('add', 'src/a.ts')
    const half = await fingerprint(repo.root)

    repo.run('add', '-A')
    expect(await fingerprint(repo.root)).toBe(half)
  })

  it('leaves the real index exactly as it was arranged', async () => {
    repo.write('src/a.ts', 'const a = 2\n')
    repo.write('src/b.ts', 'const b = 1\n')
    repo.run('add', 'src/a.ts')

    const indexPath = join(await gitDir(repo.root), 'index')
    const before = readFileSync(indexPath)
    const stagedBefore = repo.run('diff', '--cached', '--name-only')

    await fingerprint(repo.root)

    expect(readFileSync(indexPath).equals(before)).toBe(true)
    expect(repo.run('diff', '--cached', '--name-only')).toBe(stagedBefore)
    expect(stagedBefore.trim()).toBe('src/a.ts')
  })

  it('works in a repository with no commits yet', async () => {
    const fresh = tempRepo()
    try {
      fresh.write('first.ts', 'const first = 1\n')

      const diff = await diffAgainstHead(fresh.root)
      expect(diff).toContain('first.ts')
      expect(await fingerprint(fresh.root)).toHaveLength(64)
    } finally {
      fresh.cleanup()
    }
  })

  it('leaves no temporary index behind', async () => {
    const indexPath = join(await gitDir(repo.root), 'index')
    const sizeBefore = statSync(indexPath).size

    repo.write('src/a.ts', 'const a = 3\n')
    await fingerprint(repo.root)

    expect(statSync(indexPath).size).toBe(sizeBefore)
  })

  it('sees an in-place edit that keeps the file size', async () => {
    // The bug seeding a scratch index from the real one causes: the copy's
    // mtime is newer than the file, so git trusts inherited stat data, and a
    // same-size edit reads as no change while the tree plainly differs.
    const clean = await fingerprint(repo.root)

    repo.write('src/a.ts', 'const a = 9\n')
    const dirty = await fingerprint(repo.root)

    expect(dirty).not.toBe(clean)
    expect(await fingerprint(repo.root)).toBe(dirty)
    expect(await diffAgainstHead(repo.root)).toContain('const a = 9')
  })

  it('sees a deletion', async () => {
    const before = await fingerprint(repo.root)
    repo.run('rm', '-q', 'src/a.ts')

    expect(await fingerprint(repo.root)).not.toBe(before)
    expect(await diffAgainstHead(repo.root)).toContain('deleted file')
  })
})
