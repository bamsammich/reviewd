import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
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
  oldSha: string
  newSha: string
  path: string
  oldPath?: string
}

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
    // Empty on purpose. See the note in git.ts: seeding from the real index
    // makes git trust inherited stat data and miss a same-size in-place edit.
    const env = { GIT_INDEX_FILE: indexFile }
    await git(root, ['add', '-A'], env)

    const target = await resolveBase(root, base)
    const raw = await git(root, ['diff', '--cached', '--raw', '-z', '-M', target], env)
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

    const textDiff = await git(root, ['diff', '--cached', target], env)

    return {
      sourceId: source.id,
      fingerprint: createHash('sha256').update(textDiff, 'utf8').digest('hex'),
      files,
      blobs,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
    const oldSha = fields[2] ?? ''
    const newSha = fields[3] ?? ''
    const status = fields[4] ?? ''

    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = parts[i + 1] ?? ''
      const path = parts[i + 2] ?? ''
      changes.push({ status, oldSha, newSha, path, oldPath })
      i += 3
      continue
    }

    changes.push({ status, oldSha, newSha, path: parts[i + 1] ?? '' })
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
  const oldBytes = ZERO_SHA.test(change.oldSha) ? null : await catFile(root, change.oldSha, env)
  const newBytes = ZERO_SHA.test(change.newSha) ? null : await catFile(root, change.newSha, env)

  const binary =
    (oldBytes !== null && looksBinary(oldBytes)) || (newBytes !== null && looksBinary(newBytes))
  const oversize =
    (oldBytes?.length ?? 0) > limits.maxBlobBytes || (newBytes?.length ?? 0) > limits.maxBlobBytes

  // Binary and oversize content is described rather than stored. The reviewer
  // gets a row saying so, which beats a diff view rendering megabytes of noise.
  const keep = !binary && !oversize

  const oldBlobId = keep && oldBytes ? remember(blobs, oldBytes) : null
  const newBlobId = keep && newBytes ? remember(blobs, newBytes) : null

  return {
    sourceId,
    path: change.path,
    changeType: changeTypeFor(change.status, binary),
    oldPath: change.oldPath ?? null,
    oldBlobId,
    newBlobId,
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
  const parts: string[] = []

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
      isBinary: binary,
      truncated: oversize,
    })

    parts.push(`${path}:${sha256(bytes)}`)
  }

  return {
    sourceId: source.id,
    fingerprint: createHash('sha256').update(parts.sort().join('\n'), 'utf8').digest('hex'),
    files,
    blobs,
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
