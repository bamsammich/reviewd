import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pushRange, pushRemote, unpushedCommits } from './diff.js'
import { tempRepo, type TempRepo } from './testing.js'

/**
 * Which remote a push is measured against.
 *
 * The range was every commit no remote had seen, which counts a fork as
 * publication. A branch pushed to a fork and then to upstream produced an
 * empty range the second time, so the gate reported a push carrying nothing
 * while an unreviewed commit reached upstream.
 */

let repo: TempRepo

beforeEach(() => {
  repo = tempRepo()
  repo.write('base.txt', 'base\n')
  repo.commit('base')

  // Both remotes have seen the base commit.
  repo.run('update-ref', 'refs/remotes/origin/main', 'HEAD')
  repo.run('update-ref', 'refs/remotes/fork/main', 'HEAD')
  repo.run('remote', 'add', 'origin', 'https://example.invalid/origin.git')
  repo.run('remote', 'add', 'fork', 'https://example.invalid/fork.git')
})

afterEach(() => {
  repo.cleanup()
})

/** A commit only the fork has seen. */
function pushedToForkOnly(): string {
  repo.write('work.ts', 'export const work = 1\n')
  repo.commit('the change under review')
  const sha = repo.run('rev-parse', 'HEAD').trim()

  repo.run('update-ref', 'refs/remotes/fork/main', 'HEAD')

  return sha
}

describe('a branch pushed to a fork, then to upstream', () => {
  it('still carries the commit upstream has not seen', async () => {
    const sha = pushedToForkOnly()

    expect(await unpushedCommits(repo.root, 'origin')).toEqual([sha])
  })

  it('carries nothing to the fork, which already has it', async () => {
    pushedToForkOnly()

    expect(await unpushedCommits(repo.root, 'fork')).toEqual([])
  })

  /**
   * The reading that let it through. Every remote counted as published, so the
   * fork having the commit made the range empty for upstream too.
   */
  it('reads as nothing to push when every remote counts', async () => {
    pushedToForkOnly()

    expect(await unpushedCommits(repo.root, null)).toEqual([])
  })

  it('gives the gate a range to check', async () => {
    const sha = pushedToForkOnly()
    const range = await pushRange(repo.root, 'origin')

    expect(range?.commits).toEqual([sha])
  })
})

describe('the remote a push reaches when the command names none', () => {
  it('is the one the branch is configured for', async () => {
    const branch = repo.run('symbolic-ref', '--short', 'HEAD').trim()
    repo.run('config', `branch.${branch}.remote`, 'fork')

    expect(await pushRemote(repo.root)).toBe('fork')
  })

  // Which is what git does with an unconfigured branch.
  it('is origin when nothing is configured', async () => {
    expect(await pushRemote(repo.root)).toBe('origin')
  })

  it('is nothing on a detached HEAD, where no branch carries the setting', async () => {
    repo.run('checkout', '-q', '--detach')

    expect(await pushRemote(repo.root)).toBeNull()
  })

  /**
   * Read the way git reads it, so the gate's answer and the push's destination
   * are the same question.
   */
  it('decides the range when no remote is named', async () => {
    const sha = pushedToForkOnly()
    const branch = repo.run('symbolic-ref', '--short', 'HEAD').trim()

    repo.run('config', `branch.${branch}.remote`, 'origin')
    expect(await unpushedCommits(repo.root)).toEqual([sha])

    repo.run('config', `branch.${branch}.remote`, 'fork')
    expect(await unpushedCommits(repo.root)).toEqual([])
  })
})

/**
 * A remote nobody has fetched from has published nothing, so everything on the
 * branch is unpushed as far as it is concerned. Strict, and correct: naming a
 * remote reviewd holds no refs for is naming somewhere none of this has been.
 */
describe('a remote this repository holds no refs for', () => {
  it('leaves every commit on the branch to be approved', async () => {
    pushedToForkOnly()
    repo.run('remote', 'add', 'elsewhere', 'https://example.invalid/elsewhere.git')

    const commits = await unpushedCommits(repo.root, 'elsewhere')

    // Both commits: the base the other remotes have, and the one on top.
    expect(commits).toHaveLength(2)
  })
})
