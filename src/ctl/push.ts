import type { CommitSpec, FileChangeSpec, SnapshotManifest, SnapshotResult } from '../protocol.js'
import type { Client } from './client.js'
import {
  diffFromBase,
  diffPushRange,
  diffSource,
  DEFAULT_LIMITS,
  type DiffLimits,
  type SourceInput,
} from './diff.js'

/**
 * Computing every root's change set and pushing it.
 *
 * The client does the work and the daemon stores the result, which is what
 * lets a review span a repository, a second repository, and a plain directory
 * without the daemon knowing anything about how they relate.
 */
export async function pushSnapshot(
  client: Client,
  reviewId: string,
  sources: SourceInput[],
  limits: DiffLimits = DEFAULT_LIMITS,
): Promise<SnapshotResult> {
  // No fingerprint travels with this. The daemon derives it from the rows
  // below, so what an approval covers is what the review page rendered rather
  // than a number this process asserted about it.
  const files: FileChangeSpec[] = []
  const commits: CommitSpec[] = []
  const blobs = new Map<string, Uint8Array>()

  for (const source of sources) {
    // What a base means follows what the gate will ask about, because a review
    // nobody can approve into the thing it describes is worth nothing.
    //
    // Under commit gating the question is a working tree against something,
    // and a base names that something. Under push gating the question is which
    // commits are about to leave, and a base names where they start: the pull
    // request below this one in a stack is already on somebody's screen in its
    // own review, so the base is the boundary between the two.
    //
    // Narrowing a review this way is safe because the gate does not read the
    // base at all. It reads `git rev-list HEAD --not --remotes` itself and
    // wants an approval for every commit there, so a base that leaves a commit
    // out leaves it unapproved rather than sneaking it past.
    const gatedOnPush = (await scopeOf(client, source.rootPath)) === 'push'

    const push = gatedOnPush
      ? source.baseRef === undefined
        ? await diffPushRange(source, limits)
        : await diffFromBase(source, source.baseRef, limits)
      : null

    // A root with nothing to push falls back to the working tree, which is
    // what a reviewer opening the page before committing expects to read. A
    // base naming no commit lands here too, and the diff against it fails
    // loudly rather than being guessed at.
    const diff = push?.diff ?? (await diffSource(source, limits))

    files.push(...diff.files)
    if (push) commits.push(...push.commits)
    for (const [id, bytes] of diff.blobs) blobs.set(id, bytes)
  }

  const manifest: SnapshotManifest = { files, commits }

  // Ask before sending. Revision N+1 of a 200-file review usually has a
  // handful of new blobs and the daemon already holds the rest.
  const ids = [...blobs.keys()]
  const missing = ids.length > 0 ? await client.missingBlobs(reviewId, ids) : []

  for (const id of missing) {
    const bytes = blobs.get(id)
    if (bytes) await client.putBlob(id, bytes)
  }

  return client.snapshot(reviewId, manifest)
}

/**
 * How this root is gated, which decides what a revision of it describes.
 *
 * Under commit gating the question is the working tree against HEAD, because
 * that is what a commit would record. Under push gating it is the commits an
 * upstream has not seen, and the working tree is not part of it.
 *
 * The daemon answers rather than the caller deciding, so the change set the
 * reviewer approves is the one the gate will ask about. A review computed the
 * other way holds an approval the gate can never match, and a reviewer who
 * said yes finds the commit refused anyway.
 *
 * Asked once per revision rather than remembered for the life of the process,
 * so editing the config takes effect on the next snapshot instead of on the
 * next restart of an agent that may run for days.
 */
async function scopeOf(client: Client, root: string): Promise<string> {
  // A daemon that cannot answer is not a reason to refuse a revision, so an
  // older one, or one briefly unreachable, reads as commit gating: what every
  // review did before push gating existed.
  return client.gateScope(root).catch(() => 'commit')
}
