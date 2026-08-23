import type { SnapshotManifest, SnapshotResult } from '@reviewd/protocol'
import type { Client } from './client.js'
import { diffSource, DEFAULT_LIMITS, type DiffLimits, type SourceInput } from './diff.js'

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
  const manifest: SnapshotManifest = { fingerprints: {}, files: [] }
  const blobs = new Map<string, Uint8Array>()

  for (const source of sources) {
    const diff = await diffSource(source, limits)

    manifest.fingerprints[diff.sourceId] = diff.fingerprint
    manifest.files.push(...diff.files)
    for (const [id, bytes] of diff.blobs) blobs.set(id, bytes)
  }

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
