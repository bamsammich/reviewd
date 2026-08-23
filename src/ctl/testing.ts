import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** A real git repository per test, because the fingerprint is about real git. */
export interface TempRepo {
  root: string
  write: (path: string, contents: string) => void
  run: (...args: string[]) => string
  commit: (message: string) => void
  /**
   * A linked worktree on a new branch, returning its path.
   *
   * Worth having a fixture for because a worktree's `.git` is a file holding a
   * pointer rather than a directory, so anything deciding "is this a
   * repository" by looking for a directory gets it wrong.
   */
  worktree: (branch: string) => string
  cleanup: () => void
}

export function tempRepo(): TempRepo {
  const root = mkdtempSync(join(tmpdir(), 'reviewd-repo-'))

  const run = (...args: string[]): string =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    })

  run('init', '-q', '-b', 'main')
  run('config', 'commit.gpgsign', 'false')

  const write = (path: string, contents: string): void => {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }

  // Worktrees live outside the repository so removing one does not disturb it.
  const trees: string[] = []

  return {
    root,
    write,
    run,
    commit: (message: string) => {
      run('add', '-A')
      run('commit', '-q', '-m', message)
    },
    worktree: (branch: string) => {
      const path = join(mkdtempSync(join(tmpdir(), 'reviewd-worktree-')), branch)
      run('worktree', 'add', '-q', path, '-b', branch)
      trees.push(path)
      return path
    },
    cleanup: () => {
      for (const tree of trees) rmSync(dirname(tree), { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    },
  }
}
