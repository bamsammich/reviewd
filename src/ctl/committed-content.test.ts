import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diffSource, fingerprint } from './diff.js'
import { stagedDivergence } from './git.js'
import { tempRepo, type TempRepo } from './testing.js'

/**
 * The gap between what a review shows and what a commit carries.
 *
 * A review reads the working tree; `git commit` writes the index. Keeping those
 * apart is deliberate — it is what lets staging leave an approval alone — and
 * every case below is a way the two can hold different content while the
 * fingerprint says nothing has moved.
 */

let repo: TempRepo

beforeEach(() => {
  repo = tempRepo()
  repo.write('src/a.ts', 'const a = 1\n')
  repo.commit('initial')
})

afterEach(() => {
  repo.cleanup()
})

describe('staged content that differs from the tree', () => {
  it('is caught when a change is staged and the file put back', async () => {
    // Stage something, restore the file, and the tree a reviewer reads is clean
    // while the commit still carries the change.
    repo.write('src/a.ts', 'const a = 999 // not reviewed\n')
    repo.run('add', 'src/a.ts')
    repo.write('src/a.ts', 'const a = 1\n')

    expect(await stagedDivergence(repo.root)).toEqual(['src/a.ts'])
  })

  it('is caught when only part of a change is staged', async () => {
    repo.write('src/a.ts', 'const a = 2\n')
    repo.run('add', 'src/a.ts')
    repo.write('src/a.ts', 'const a = 3\n')

    expect(await stagedDivergence(repo.root)).toEqual(['src/a.ts'])
  })

  it('says nothing about a tree with nothing staged', async () => {
    repo.write('src/a.ts', 'const a = 2\n')

    expect(await stagedDivergence(repo.root)).toEqual([])
  })

  it('says nothing about a fully staged change, which is ordinary', async () => {
    repo.write('src/a.ts', 'const a = 2\n')
    repo.run('add', '-A')

    expect(await stagedDivergence(repo.root)).toEqual([])
  })

  it('says nothing about untracked files, which are not staged', async () => {
    repo.write('src/b.ts', 'const b = 1\n')

    expect(await stagedDivergence(repo.root)).toEqual([])
  })

  it('says nothing about a clean tree', async () => {
    expect(await stagedDivergence(repo.root)).toEqual([])
  })
})

describe('files git is carrying that the ignore rules hide', () => {
  it('moves the fingerprint when an ignored file is force-staged', async () => {
    // `git add -A` honours .gitignore, so `dist/` is invisible to a review.
    // `git add -f dist/payload.js` puts it in the index anyway, and a commit
    // will carry it. Every repository with a dist/ supplies the cover.
    repo.write('.gitignore', 'dist/\n')
    const before = await fingerprint(repo.root)

    repo.write('dist/payload.js', 'console.log("not reviewed")\n')
    repo.run('add', '-f', 'dist/payload.js')

    expect(await fingerprint(repo.root)).not.toBe(before)
  })

  it('leaves an ignored file nobody staged out of the reading', async () => {
    // Build output should not turn up in a diff just for existing.
    repo.write('.gitignore', 'dist/\n')
    const before = await fingerprint(repo.root)

    repo.write('dist/bundle.js', 'console.log("build output")\n')

    expect(await fingerprint(repo.root)).toBe(before)
  })
})

describe('what the fingerprint still ignores, on purpose', () => {
  it('does not move when a change is staged rather than left in the tree', async () => {
    // Otherwise an approval would die at the moment of the commit it cleared.
    repo.write('src/a.ts', 'const a = 2\n')
    const unstaged = await fingerprint(repo.root)

    repo.run('add', '-A')

    expect(await fingerprint(repo.root)).toBe(unstaged)
  })
})

/**
 * The tree the gate records, which is what `reviewd observe` compares a commit
 * against afterwards.
 *
 * The fingerprint says whether a tree matches a review. It cannot say whether
 * the tree that was approved is the tree that got committed, because the gate
 * runs before the command and the command can write files before it commits.
 * The tree sha answers that, and only if it names the same reading.
 */
describe('the tree a reading would commit', () => {
  it('is the tree git records when the reading is committed unchanged', async () => {
    repo.write('src/a.ts', 'const a = 2 // reviewed\n')
    const { tree } = await diffSource({ id: '', rootPath: repo.root })

    repo.run('add', '-A')
    repo.commit('the reviewed change')

    expect(tree).toBe(repo.run('rev-parse', 'HEAD^{tree}').trim())
  })

  /** What an in-place edit in front of the commit produces. */
  it('differs from the commit when something writes the tree in between', async () => {
    repo.write('src/a.ts', 'const a = 2 // reviewed\n')
    const { tree } = await diffSource({ id: '', rootPath: repo.root })

    repo.write('src/a.ts', 'const a = 999 // never reviewed\n')
    repo.run('add', '-A')
    repo.commit('carries something else')

    expect(tree).not.toBe(repo.run('rev-parse', 'HEAD^{tree}').trim())
  })

  it('does not move when a change is only staged', async () => {
    // Same promise the fingerprint makes: an approval survives `git add`.
    repo.write('src/a.ts', 'const a = 2\n')
    const unstaged = await diffSource({ id: '', rootPath: repo.root })

    repo.run('add', '-A')

    expect((await diffSource({ id: '', rootPath: repo.root })).tree).toBe(unstaged.tree)
  })
})
