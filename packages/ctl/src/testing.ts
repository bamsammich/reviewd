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
  cleanup: () => void
}

export function tempRepo(): TempRepo {
  const root = mkdtempSync(join(tmpdir(), 'reviewctl-repo-'))

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

  return {
    root,
    write,
    run,
    commit: (message: string) => {
      run('add', '-A')
      run('commit', '-q', '-m', message)
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
