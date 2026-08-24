import { execFile } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

/**
 * The one spelling of a path that everything agrees on.
 *
 * A root reaches the daemon from two directions: whatever a caller typed when
 * opening a review, and what `git rev-parse` reports when the commit hook asks.
 * git resolves symlinks and a caller usually does not, so on macOS a review
 * opened on /var/folders/... is asked about as /private/var/folders/... and the
 * gate denies every commit while insisting nobody has looked at the repository.
 */
export function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
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
  const dir = mkdtempSync(join(tmpdir(), 'reviewd-index-'))
  const indexFile = join(dir, 'index')

  try {
    // The scratch index starts empty on purpose.
    //
    // Seeding it from the real index is the obvious optimization and it is
    // wrong: the copy's mtime is newer than every file, so git trusts the
    // stat data it inherited instead of re-reading content. An in-place edit
    // that keeps a file's size then reads as no change at all, and the
    // fingerprint comes back as the hash of an empty diff while the working
    // tree plainly differs. For a value the commit gate rests on, a full
    // re-read is the right trade.
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

/**
 * Paths where the index holds something that is neither HEAD nor the tree.
 *
 * The review reads the working tree; `git commit` writes the index. Keeping
 * those apart is what lets staging leave the fingerprint alone, and it is also
 * a hole: stage a change, restore the file, and the tree the reviewer reads is
 * clean while the commit still carries the change. `git status` calls that
 * `MM`, and it is the one arrangement where approving what is on disk says
 * nothing about what is about to be committed.
 *
 * A tree that is wholly staged, wholly unstaged, or untouched all pass. What
 * does not is a half-staged file — `git add -p`, or the sequence above — where
 * the committed content matches neither what was reviewed nor what it replaced.
 */
export async function stagedDivergence(root: string): Promise<string[]> {
  const status = await git(root, ['status', '--porcelain', '-z'])
  const diverged: string[] = []

  for (const entry of status.split('\0')) {
    if (entry.length < 4) continue

    const index = entry[0] as string
    const tree = entry[1] as string

    // Untracked is not staged, and a clean side means the two agree.
    if (index === ' ' || index === '?' || tree === ' ') continue

    diverged.push(entry.slice(3))
  }

  return diverged
}
