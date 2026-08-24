import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { looksBinary } from './ctl/diff.js'

/**
 * No source file may read as binary.
 *
 * `looksBinary` calls anything with a NUL byte in its first 8KB binary, which is
 * what git does and is right for a diff view: nobody wants a `.wasm` rendered as
 * text. The consequence is that a source file containing a raw control byte is
 * described rather than shown, so it appears in a review as a row saying
 * "binary" and the reviewer approves it unread.
 *
 * That happened to `fingerprint.ts`, which uses NUL and SOH as hash separators —
 * the correct choice, since a path can contain any printable character — typed
 * as literal bytes rather than escapes. The file defining what an approval
 * covers became the one file the approval could not show.
 *
 * The separators are still those bytes. They are written as escapes,
 * which is the same value and a file anyone can read.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue

    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* sourceFiles(path)
      continue
    }

    if (entry.isFile() && /\.(ts|js|json|md|sh|yaml|yml)$/.test(entry.name)) yield path
  }
}

describe('every source file can be shown in a review', () => {
  it('holds no byte that makes it read as binary', () => {
    const offenders: string[] = []

    for (const path of sourceFiles(HERE)) {
      if (statSync(path).size === 0) continue
      if (looksBinary(new Uint8Array(readFileSync(path)))) {
        offenders.push(path.slice(HERE.length))
      }
    }

    expect(offenders, 'these would render as "binary" and be approved unread').toEqual([])
  })

  it('agrees that the separators are still the bytes they should be', () => {
    // The escape has to survive any future reformat: this is the property the
    // hash depends on, not the spelling.
    const source = readFileSync(join(HERE, 'fingerprint.ts'), 'utf8')

    expect(source).toContain('\\u0000')
    expect(source).toContain('\\u0001')
    expect(source).not.toContain(String.fromCharCode(0))
  })
})
