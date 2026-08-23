import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { raw, type SafeHtml } from './html.js'

/**
 * Icons, taken from Phosphor rather than drawn here.
 *
 * A hand-drawn glyph is a glyph only its author recognises. These are read
 * from the package at startup rather than pasted in, so the shapes stay
 * whatever Phosphor says they are and an upgrade is an upgrade rather than a
 * redraw.
 *
 * Read from disk rather than imported because the daemon compiles with tsc and
 * nothing turns an SVG into a module. One read each, once per process.
 */

const require_ = createRequire(import.meta.url)

/**
 * An icon is decoration until something names it, so every caller gets
 * `aria-hidden` and has to put the meaning in text of its own.
 *
 * Each file is resolved by its own subpath, which the package publishes for
 * exactly this. Reaching for the package directory instead fails, because its
 * exports map does not offer package.json — the way it was written first.
 */
function load(name: string, className: string): SafeHtml {
  try {
    const path = require_.resolve(`@phosphor-icons/core/regular/${name}.svg`)
    const svg = readFileSync(path, 'utf8')

    return raw(
      svg.replace(
        '<svg ',
        `<svg class="${className}" width="14" height="14" aria-hidden="true" `,
      ),
    )
  } catch (error) {
    // A missing icon is a blemish; a daemon that will not start is an outage.
    // Said once, at startup, where the log is read.
    process.stderr.write(
      `reviewd: icon "${name}" could not be read, rendering without it: ${String(error)}\n`,
    )
    return raw('')
  }
}

/** A source under version control. */
export const GIT_ICON = load('git-branch', 'vcs')

/** A source that is just a directory. */
export const FOLDER_ICON = load('folder', 'vcs')
