import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from './client.js'
import { observeCommit } from './commands.js'
import { git } from './git.js'
import { tempRepo, type TempRepo } from './testing.js'

/**
 * What `reviewd observe` does about a repository that opted out.
 *
 * A repository carrying `.git/reviewd-gate-off` never reaches the gate, so no
 * approval is consumed and every commit in it comes back `ungated`. Saying so
 * blames the gate for a decision somebody made on purpose, on every command.
 *
 * The assertion is that the daemon is never asked, rather than that nothing was
 * printed: no daemon runs in this suite, so silence proves nothing on its own.
 */
let repo: TempRepo
let asked: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  repo = tempRepo()
  repo.write('a.ts', 'const a = 1\n')
  repo.commit('base')

  asked = vi
    .spyOn(Client.prototype, 'observe')
    .mockResolvedValue({ finding: 'ungated', reason: 'stubbed', reviewUrl: null })
})

afterEach(() => {
  asked.mockRestore()
  repo.cleanup()
})

async function optOut(root: string): Promise<void> {
  // Through the git directory git reports, which is not `<root>/.git` in a
  // worktree or a submodule.
  const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim()
  writeFileSync(join(gitDir, 'reviewd-gate-off'), '')
}

describe('a repository that opted out', () => {
  it('is never asked about', async () => {
    await optOut(repo.root)

    await observeCommit(repo.root)

    expect(asked).not.toHaveBeenCalled()
  })

  it('is asked about again once the marker is gone', async () => {
    await observeCommit(repo.root)

    expect(asked).toHaveBeenCalledTimes(1)
  })

  it('reports what the daemon says when the gate is on', async () => {
    const stderr: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk))
      return true
    })

    try {
      await observeCommit(repo.root)
      expect(stderr.join('')).toContain('stubbed')
    } finally {
      write.mockRestore()
    }
  })
})
