import { createHash } from 'node:crypto'
import type { FileChangeSpec } from './protocol.js'

/**
 * Separators that cannot occur in the values they separate.
 *
 * A path may contain a space, a comma, or a newline, so any printable delimiter
 * lets two different change sets hash the same: `a b` with no old path and `a`
 * with an old path of `b` are the same string once joined by a space. Control
 * bytes cannot appear in any of these fields, so the split is unambiguous.
 *
 * Written as escapes rather than typed literally. The bytes are identical, but
 * a source file holding a raw NUL reads as binary — including to reviewd's own
 * `looksBinary` — so the file describing what an approval covers becomes the
 * one file a reviewer cannot see. That happened.
 */
const FIELD = '\u0000'
const ROW = '\u0001'

/** What `manifestFingerprint([])` returns: a tree with nothing to review. */
export const EMPTY_FINGERPRINT = createHash('sha256').update('', 'utf8').digest('hex')

/**
 * What an approval covers.
 *
 * This used to be a sha256 of `git diff` text that the client computed and the
 * daemon stored on trust. Two things were wrong with that. The daemon could not
 * check it, so a client was free to upload one set of bytes for the reviewer to
 * read and assert the hash of another; and diff text describes the working
 * tree, while a commit takes the index, so the value answered a question next
 * to the one the gate was asking.
 *
 * Hashing the change set fixes the first: the daemon recomputes this from the
 * manifest it stored and ignores whatever the client claimed, so "approved"
 * names the rows the review page rendered. The second is fixed in `diff.ts`,
 * by making the change set cover what a commit would actually carry.
 *
 * `sourceId` is deliberately absent from the hash. The same tree has to produce
 * the same value from the commit gate, which knows a path and not a review.
 */
export function manifestFingerprint(files: readonly FileChangeSpec[]): string {
  const rows = files
    .map((file) =>
      [file.path, file.oldPath ?? '', file.changeType, file.oldHash ?? '', file.newHash ?? ''].join(
        FIELD,
      ),
    )
    .sort()

  return createHash('sha256').update(rows.join(ROW), 'utf8').digest('hex')
}

/** The per-source fingerprints of a whole manifest, keyed by source id. */
export function fingerprintsBySource(
  files: readonly FileChangeSpec[],
  sourceIds: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {}

  for (const sourceId of sourceIds) {
    out[sourceId] = manifestFingerprint(files.filter((file) => file.sourceId === sourceId))
  }

  return out
}
