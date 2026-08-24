import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
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
  const entries = status.split('\0')
  const diverged: string[] = []

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] as string
    if (entry.length < 4) continue

    const index = entry[0] as string
    const tree = entry[1] as string

    // A rename or a copy spends a second NUL-separated chunk on the path the
    // content came from, and it is a bare path with no status bytes in front
    // of it. Reading it as an entry of its own is what made `git mv a/foo.ts
    // b/foo.ts` report an index status of 'a', a tree status of '/', and a
    // path of "oo.ts" — a divergence naming a file that does not exist, on
    // every commit carrying a rename, which no approval could ever clear.
    // R and C are the only statuses that do this; A, D, M, ?? and the
    // unmerged pairs all fit in one chunk.
    if (index === 'R' || index === 'C') i += 1

    // Untracked is not staged, and a clean side means the two agree.
    if (index === ' ' || index === '?' || tree === ' ') continue

    diverged.push(entry.slice(3))
  }

  return diverged
}
