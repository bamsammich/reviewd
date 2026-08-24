import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_FINGERPRINT } from '../fingerprint.js'
import { fingerprint } from './diff.js'
import { canonical, gitDir, repoRoot, stagedDivergence } from './git.js'
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
    expect(found).toMatch(/reviewd-repo-/)
  })

  it('answers null outside a repository', async () => {
    expect(await repoRoot('/')).toBeNull()
  })
})

describe('canonical', () => {
  it('agrees with what git reports for the same directory', async () => {
    // The bug this exists for: on macOS /var is a symlink to /private/var, so
    // a review opened on the path a caller typed is asked about under the path
    // git resolves, and the gate denies every commit while insisting nobody
    // has looked at the repository.
    expect(canonical(repo.root)).toBe(await repoRoot(repo.root))
  })

  it('is stable when applied twice', () => {
    expect(canonical(canonical(repo.root))).toBe(canonical(repo.root))
  })

  it('resolves a path that does not exist rather than throwing', () => {
    expect(canonical('/tmp/reviewd-not-here')).toBe('/tmp/reviewd-not-here')
  })
})

describe('fingerprint', () => {
  it('is stable while nothing changes', async () => {
    repo.write('src/a.ts', 'const a = 2\n')

    expect(await fingerprint(repo.root)).toBe(await fingerprint(repo.root))
  })

  it('is the empty hash on a clean tree', async () => {
    // The gate reads this exact value to mean "nothing to review", which is
    // what lets an --amend that only edits a message through.
    expect(await fingerprint(repo.root)).toBe(EMPTY_FINGERPRINT)
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

      const first = await fingerprint(fresh.root)
      expect(first).toHaveLength(64)
      expect(first).not.toBe(EMPTY_FINGERPRINT)
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
  })

  it('sees a deletion', async () => {
    const before = await fingerprint(repo.root)
    repo.run('rm', '-q', 'src/a.ts')

    expect(await fingerprint(repo.root)).not.toBe(before)
  })
})

describe('stagedDivergence', () => {
  it('says nothing about a staged rename', async () => {
    // `git status --porcelain -z` spends a second NUL-separated chunk on the
    // path a rename came from, and it carries no status bytes. Reading it as
    // an entry of its own turned `git mv src/a.ts src/b.ts` into a divergence
    // on "c/a.ts", so every commit carrying a rename was denied over a file
    // that does not exist, and no approval could clear it.
    repo.run('mv', 'src/a.ts', 'src/b.ts')

    expect(await stagedDivergence(repo.root)).toEqual([])
  })

  it('catches a rename whose new path was edited afterwards', async () => {
    // `RM`: the index holds the move, the tree holds the move plus content the
    // reviewer never saw.
    repo.run('mv', 'src/a.ts', 'src/b.ts')
    repo.write('src/b.ts', 'const a = 999 // not reviewed\n')

    expect(await stagedDivergence(repo.root)).toEqual(['src/b.ts'])
  })

  it('reads the entry after a rename as an entry rather than as a path', async () => {
    repo.write('src/z.ts', 'const z = 1\n')
    repo.commit('add z')

    repo.run('mv', 'src/a.ts', 'src/b.ts')
    repo.write('src/z.ts', 'const z = 2\n')
    repo.run('add', 'src/z.ts')
    repo.write('src/z.ts', 'const z = 3\n')

    expect(await stagedDivergence(repo.root)).toEqual(['src/z.ts'])
  })

  it('still catches a file staged and then edited again', async () => {
    repo.write('src/a.ts', 'const a = 2\n')
    repo.run('add', 'src/a.ts')
    repo.write('src/a.ts', 'const a = 3\n')

    expect(await stagedDivergence(repo.root)).toEqual(['src/a.ts'])
  })
})
