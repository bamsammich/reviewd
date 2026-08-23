import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const MAX_BUFFER = 256 * 1024 * 1024

export class GitError extends Error {}

export async function git(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', root, ...args], {
      env: { ...process.env, ...env },
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    })
    return stdout
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new GitError(`git ${args.join(' ')} failed in ${root}: ${message}`)
  }
}

export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return null
  }
}

export async function gitDir(root: string): Promise<string> {
  return (await git(root, ['rev-parse', '--absolute-git-dir'])).trim()
}

async function hasCommits(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/**
 * The content of every change against HEAD, tracked or not, staged or not.
 *
 * Staging must not change the answer. A fingerprint that moved when `git add`
 * ran would invalidate an approval at the moment of the commit it had just
 * cleared, so everything is staged into a throwaway index and diffed in one
 * pass. The real index is never written, which leaves a half-staged tree
 * exactly as it was arranged.
 */
export async function diffAgainstHead(root: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'reviewctl-index-'))
  const indexFile = join(dir, 'index')

  try {
    // Seeding from the real index keeps unchanged files on their cached hashes
    // instead of re-reading the whole tree. A missing or empty index is left
    // absent rather than created empty, since git refuses a zero-byte index.
    const real = join(await gitDir(root), 'index')
    if (sizeOf(real) > 0) {
      const { copyFileSync } = await import('node:fs')
      copyFileSync(real, indexFile)
    }

    const env = { GIT_INDEX_FILE: indexFile }
    await git(root, ['add', '-A'], env)

    if (await hasCommits(root)) {
      return await git(root, ['diff', '--cached', 'HEAD'], env)
    }

    // No commits yet, so compare against the empty tree and a first review works.
    const empty = (await git(root, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
    return await git(root, ['diff', '--cached', empty], env)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function fingerprint(root: string): Promise<string> {
  return createHash('sha256')
    .update(await diffAgainstHead(root), 'utf8')
    .digest('hex')
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
