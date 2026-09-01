import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { manifestFingerprint } from '../fingerprint.js'
import type { ChangeType, FileChangeSpec } from '../protocol.js'
import { canonical, git, repoRoot } from './git.js'

const run = promisify(execFile)
const MAX_BUFFER = 256 * 1024 * 1024
const ZERO_SHA = /^0+$/

/**
 * Turning a working tree into a change set the daemon can store.
 *
 * Everything here runs on the machine holding the code, because the daemon
 * never touches git. That is what makes several roots in one review ordinary:
 * each is walked on its own and the results are concatenated.
 */

export interface SourceInput {
  /** Id the daemon assigned to this source. */
  id: string
  rootPath: string
  /** Absent for a plain file set. */
  baseRef?: string | undefined
}

export interface Blob {
  id: string
  bytes: Uint8Array
}

export interface SourceDiff {
  sourceId: string
  fingerprint: string
  files: FileChangeSpec[]
  blobs: Map<string, Uint8Array>
  /**
   * The tree a commit of this reading would carry, or null off a git source.
   *
   * Written from the same scratch index the fingerprint is read out of, so the
   * two describe one tree rather than two readings that can disagree. `reviewd
   * observe` compares it against what a commit actually recorded.
   */
  tree: string | null
}

export interface DiffLimits {
  maxBlobBytes: number
  maxFilesPerSnapshot: number
}

export const DEFAULT_LIMITS: DiffLimits = {
  maxBlobBytes: 2 * 1024 * 1024,
  maxFilesPerSnapshot: 2000,
}

/** Directories never worth reading, whatever the source says. */
const ALWAYS_SKIP = new Set(['.git', 'node_modules'])

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A NUL byte in the first 8KB is what git itself treats as binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192)
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// git sources
// ---------------------------------------------------------------------------

interface RawChange {
  status: string
  oldMode: string
  newMode: string
  oldSha: string
  newSha: string
  path: string
  oldPath?: string
}

/**
 * The mode git gives a submodule entry.
 *
 * A gitlink's sha names a commit in the submodule's own object database, which
 * the superproject does not have, so asking it for the blob fails outright.
 * Reading the mode is the only way to tell one apart from a file.
 */
const GITLINK_MODE = '160000'

/**
 * Reads every change against the base ref out of a throwaway index.
 *
 * Staging into a scratch index is what makes tracked and untracked changes one
 * list, and it leaves the reviewer's own staging untouched.
 */
export async function diffGitSource(
  source: SourceInput,
  limits: DiffLimits = DEFAULT_LIMITS,
): Promise<SourceDiff> {
  const root = source.rootPath
  const base = source.baseRef ?? 'HEAD'
  const dir = mkdtempSync(join(tmpdir(), 'reviewd-diff-'))
  const indexFile = join(dir, 'index')

  try {
    // The scratch index starts empty on purpose.
    //
    // Seeding it from the real index is the obvious optimization and it is
    // wrong: the copy's mtime is newer than every file, so git trusts the stat
    // data it inherited instead of re-reading content. An in-place edit that
    // keeps a file's size then reads as no change at all, and the fingerprint
    // comes back describing a tree that plainly differs from the one on disk.
    // For a value the commit gate rests on, a full re-read is the right trade.
    const env = { GIT_INDEX_FILE: indexFile }
    await git(root, ['add', '-A'], env)

    const target = await resolveBase(root, base)
    await includeStagedIgnores(root, target, env)
    // --abbrev=40 because a submodule's sha becomes content here, and git scales
    // its default abbreviation with the size of the object database. Left to
    // vary, the same pointer would hash differently as a repository grew and
    // re-arm the gate for a change nobody made.
    const raw = await git(
      root,
      ['diff', '--cached', '--raw', '-z', '--abbrev=40', '-M', target],
      env,
    )
    const changes = parseRawDiff(raw)

    if (changes.length > limits.maxFilesPerSnapshot) {
      throw new Error(
        `${root} has ${changes.length} changed files, over the ${limits.maxFilesPerSnapshot} limit`,
      )
    }

    const files: FileChangeSpec[] = []
    const blobs = new Map<string, Uint8Array>()

    for (const change of changes) {
      files.push(await toFileChange(root, source.id, change, env, blobs, limits))
    }

    // Written from the index the diff was just read out of, so it names the
    // same tree rather than a second reading of a directory that may have moved.
    const tree = (await git(root, ['write-tree'], env)).trim()

    return {
      sourceId: source.id,
      fingerprint: manifestFingerprint(files),
      files,
      blobs,
      tree,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The gate's reading of a working tree.
 *
 * This has to be the same function the snapshot used, or the gate compares two
 * hashes of two different things and an approval never matches. So it runs the
 * same diff and the same `manifestFingerprint` rather than hashing diff text,
 * which is what let the two drift apart before.
 */
export async function fingerprint(root: string): Promise<string> {
  const { files } = await diffSource({ id: '', rootPath: root })
  return manifestFingerprint(files)
}

/**
 * Pulls force-staged ignored files into the reading.
 *
 * `git add -A` honours `.gitignore`, which is right for a review: nobody wants
 * `dist/` in a diff. But `git add -f dist/payload.js` puts an ignored file in
 * the real index, and `git commit` will carry it. Reading only the ignore rules
 * meant such a file appeared in no review and moved no fingerprint, so an
 * approval taken over the visible tree cleared it too.
 *
 * Every repository with a `dist/` or a `.env` already supplies the cover, so
 * this is not an exotic case. Anything the real index is carrying is something
 * the reviewer has to see.
 */
async function includeStagedIgnores(
  root: string,
  target: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // Deliberately without env: this reads the repository's real index.
  const staged = await git(root, ['diff', '--cached', '--name-only', '-z', target])

  // Only paths still on disk. A staged deletion has nothing to add, and
  // `git add` treats a pathspec matching no file as an error rather than as
  // nothing to do; the scratch index already recorded the removal anyway.
  const paths = staged.split('\0').filter((path) => path.length > 0 && existsSync(join(root, path)))

  if (paths.length === 0) return

  await git(root, ['add', '-A', '-f', '--', ...paths], env)
}

async function resolveBase(root: string, base: string): Promise<string> {
  if (base !== 'HEAD') return base

  try {
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    return 'HEAD'
  } catch {
    // No commits yet, so everything is an addition against the empty tree.
    return (await git(root, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
  }
}

/**
 * Parses `git diff --raw -z`.
 *
 * Each record is `:<modes> <shas> <status>` then NUL-separated paths, with a
 * rename carrying two of them. The NUL form is the only one safe against paths
 * holding spaces or quotes.
 */
export function parseRawDiff(raw: string): RawChange[] {
  const parts = raw.split('\0')
  const changes: RawChange[] = []
  let i = 0

  while (i < parts.length) {
    const header = parts[i]
    if (!header || !header.startsWith(':')) {
      i += 1
      continue
    }

    const fields = header.slice(1).split(' ')
    const oldMode = fields[0] ?? ''
    const newMode = fields[1] ?? ''
    const oldSha = fields[2] ?? ''
    const newSha = fields[3] ?? ''
    const status = fields[4] ?? ''

    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = parts[i + 1] ?? ''
      const path = parts[i + 2] ?? ''
      changes.push({ status, oldMode, newMode, oldSha, newSha, path, oldPath })
      i += 3
      continue
    }

    changes.push({ status, oldMode, newMode, oldSha, newSha, path: parts[i + 1] ?? '' })
    i += 2
  }

  return changes
}

async function toFileChange(
  root: string,
  sourceId: string,
  change: RawChange,
  env: NodeJS.ProcessEnv,
  blobs: Map<string, Uint8Array>,
  limits: DiffLimits,
): Promise<FileChangeSpec> {
  const oldBytes = await sideBytes(root, change.oldMode, change.oldSha, env)
  const newBytes = await sideBytes(root, change.newMode, change.newSha, env)

  const binary =
    (oldBytes !== null && looksBinary(oldBytes)) || (newBytes !== null && looksBinary(newBytes))
  const oversize =
    (oldBytes?.length ?? 0) > limits.maxBlobBytes || (newBytes?.length ?? 0) > limits.maxBlobBytes

  // Binary and oversize content is described rather than stored. The reviewer
  // gets a row saying so, which beats a diff view rendering megabytes of noise.
  const keep = !binary && !oversize

  const oldBlobId = keep && oldBytes ? remember(blobs, oldBytes) : null
  const newBlobId = keep && newBytes ? remember(blobs, newBytes) : null

  // Hashed either way. Skipping this for content nobody uploads would leave a
  // 3 MB generated file or a prebuilt binary outside the approval entirely, so
  // swapping it after approval would not move the fingerprint.
  const oldHash = oldBytes ? sha256(oldBytes) : null
  const newHash = newBytes ? sha256(newBytes) : null

  return {
    sourceId,
    path: change.path,
    changeType: changeTypeFor(change.status, binary),
    oldPath: change.oldPath ?? null,
    oldBlobId,
    newBlobId,
    oldHash,
    newHash,
    isBinary: binary,
    truncated: oversize,
  }
}

function changeTypeFor(status: string, binary: boolean): ChangeType {
  if (binary) return 'binary'
  if (status.startsWith('A')) return 'added'
  if (status.startsWith('D')) return 'deleted'
  if (status.startsWith('R')) return 'renamed'
  return 'modified'
}

function remember(blobs: Map<string, Uint8Array>, bytes: Uint8Array): string {
  const id = sha256(bytes)
  if (!blobs.has(id)) blobs.set(id, bytes)
  return id
}

/**
 * The bytes for one side of a change, or null when that side does not exist.
 *
 * A submodule has no bytes to read. What stands in for them is the line git
 * itself renders for a gitlink, so the diff a reviewer sees says the same thing
 * `git diff` would and the ordinary rendering path needs to know nothing about
 * submodules.
 *
 * Hashing that line is what makes the pointer part of the approval. A moved
 * submodule is a real change to what the superproject builds, so it has to move
 * the fingerprint and re-arm the gate rather than ride along under an approval
 * given for the commit before it.
 */
async function sideBytes(
  root: string,
  mode: string,
  sha: string,
  env: NodeJS.ProcessEnv,
): Promise<Uint8Array | null> {
  if (ZERO_SHA.test(sha)) return null
  if (mode === GITLINK_MODE) return new TextEncoder().encode(`Subproject commit ${sha}\n`)
  return await catFile(root, sha, env)
}

async function catFile(root: string, sha: string, env: NodeJS.ProcessEnv): Promise<Uint8Array> {
  const { stdout } = await run('git', ['-C', root, 'cat-file', 'blob', sha], {
    env: { ...process.env, ...env },
    maxBuffer: MAX_BUFFER,
    encoding: 'buffer',
  })
  return new Uint8Array(stdout)
}

// ---------------------------------------------------------------------------
// plain file sets
// ---------------------------------------------------------------------------

/**
 * A directory under no version control.
 *
 * Everything reads as an addition, since there is no base to compare against.
 * The fingerprint hashes paths and content hashes together, so it moves when
 * any file does.
 */
export async function diffFileSet(
  source: SourceInput,
  limits: DiffLimits = DEFAULT_LIMITS,
): Promise<SourceDiff> {
  const files: FileChangeSpec[] = []
  const blobs = new Map<string, Uint8Array>()

  for (const path of walk(source.rootPath, limits.maxFilesPerSnapshot)) {
    const bytes = new Uint8Array(readFileSync(join(source.rootPath, path)))
    const binary = looksBinary(bytes)
    const oversize = bytes.length > limits.maxBlobBytes
    const keep = !binary && !oversize

    const newBlobId = keep ? remember(blobs, bytes) : null

    files.push({
      sourceId: source.id,
      path,
      changeType: binary ? 'binary' : 'added',
      oldPath: null,
      oldBlobId: null,
      newBlobId,
      oldHash: null,
      newHash: sha256(bytes),
      isBinary: binary,
      truncated: oversize,
    })
  }

  return {
    sourceId: source.id,
    fingerprint: manifestFingerprint(files),
    files,
    blobs,
    // No git here, so nothing writes a tree.
    tree: null,
  }
}

function* walk(root: string, limit: number, prefix = ''): Generator<string> {
  let seen = 0

  const stack: string[] = [prefix]
  while (stack.length > 0) {
    const current = stack.pop() as string
    const absolute = current ? join(root, current) : root

    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (ALWAYS_SKIP.has(entry.name)) continue

      const rel = current ? `${current}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        stack.push(rel)
        continue
      }
      if (!entry.isFile()) continue

      seen += 1
      if (seen > limit) {
        throw new Error(`${root} holds more than ${limit} files`)
      }

      yield rel
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Which of the two readings a source gets.
 *
 * An absent base used to mean "plain file set", so a repository opened without
 * one was read as a directory and every tracked file came back as an addition.
 * A two-file change to a dotfiles repo arrived as 279 additions and a 100MB
 * page, and the tool schema had promised HEAD by default the whole time.
 *
 * A missing base is not a statement about the source, so ask the source
 * instead: a repository compares against HEAD, and anything else is a file set.
 *
 * Only the top level counts as a repository. `git add -A` stages the whole
 * repository no matter which directory it runs from, so treating a
 * subdirectory as one would quietly widen the review past the directory that
 * was asked for. It also could not clear the commit gate, which matches an
 * approval on the root git reports rather than on whatever path was reviewed.
 * A subdirectory is therefore read as what it was passed as: a directory.
 */
export async function diffSource(
  source: SourceInput,
  limits: DiffLimits = DEFAULT_LIMITS,
): Promise<SourceDiff> {
  if (source.baseRef !== undefined) return diffGitSource(source, limits)

  const root = await repoRoot(source.rootPath)
  const isRepoRoot = root !== null && canonical(root) === canonical(source.rootPath)

  return isRepoRoot
    ? diffGitSource({ ...source, baseRef: 'HEAD' }, limits)
    : diffFileSet(source, limits)
}

export function relativeTo(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

/**
 * The commits on HEAD that no remote has yet, newest first.
 *
 * `--not --remotes` rather than `@{upstream}..HEAD`, because the obvious range
 * breaks on the first push of a new branch, which is exactly when a review
 * matters most. Excluding every remote ref also keeps commits somebody else
 * wrote out of the range: a merge brings in work a remote already has, and an
 * approval should cover what you wrote rather than what you pulled.
 *
 * Known gap, filed rather than solved: any remote counts as published, so a
 * branch pushed to a fork and then to upstream produces an empty range the
 * second time.
 */
export async function unpushedCommits(root: string): Promise<string[]> {
  const out = await git(root, ['rev-list', 'HEAD', '--not', '--remotes'])
  return out.split('\n').filter((line) => line.length > 0)
}

/** What a push would carry: the two ends of the range, or null when nothing would go. */
export async function pushRange(
  root: string,
): Promise<{ base: string; head: string; commits: string[] } | null> {
  const commits = await unpushedCommits(root)
  if (commits.length === 0) return null

  const oldest = commits[commits.length - 1] as string
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim()

  // The parent of the oldest unpushed commit is the last state a remote saw.
  // A first commit on a repository has no parent, so the range starts from the
  // empty tree and every file reads as an addition.
  let base: string
  try {
    base = (await git(root, ['rev-parse', '--verify', `${oldest}^`])).trim()
  } catch {
    base = (await git(root, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
  }

  return { base, head, commits }
}

/**
 * The change set between two commits, with no working tree involved.
 *
 * diffGitSource builds a scratch index from the files on disk, because what it
 * describes is what a commit would carry. A push carries commits that already
 * exist, so both sides here are trees git already holds and the working tree
 * is not part of the question. Uncommitted edits are therefore invisible to a
 * push review, which is correct: they are not being pushed.
 */
export async function diffCommitRange(
  source: SourceInput,
  range: { base: string; head: string },
  limits: DiffLimits = DEFAULT_LIMITS,
): Promise<SourceDiff> {
  const root = source.rootPath
  const env: NodeJS.ProcessEnv = {}

  const raw = await git(root, ['diff', '--raw', '-z', '--abbrev=40', '-M', range.base, range.head])
  const changes = parseRawDiff(raw)

  if (changes.length > limits.maxFilesPerSnapshot) {
    throw new Error(
      `${root} changes ${changes.length} files across the commits being pushed, ` +
        `over the ${limits.maxFilesPerSnapshot} limit`,
    )
  }

  const files: FileChangeSpec[] = []
  const blobs = new Map<string, Uint8Array>()

  for (const change of changes) {
    files.push(await toFileChange(root, source.id, change, env, blobs, limits))
  }

  return {
    sourceId: source.id,
    fingerprint: manifestFingerprint(files),
    files,
    blobs,
    // The tree the range ends at, which is what a push would publish.
    tree: (await git(root, ['rev-parse', `${range.head}^{tree}`])).trim(),
  }
}
