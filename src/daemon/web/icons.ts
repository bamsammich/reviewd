import { ICONS } from './icons.generated.js'
import { raw, type SafeHtml } from './html.js'

/**
 * Icons, taken from Phosphor rather than drawn here.
 *
 * A hand-drawn glyph is a glyph only its author recognises. The shapes stay
 * whatever Phosphor says they are, and an upgrade is an upgrade rather than a
 * redraw: `npm run icons` rewrites `icons.generated.ts` from the package.
 *
 * They arrive through that generated file rather than off disk at startup.
 * Reading the package meant shipping it, and the published tarball carried 37MB
 * of icon set to serve the two below.
 */

/**
 * An icon is decoration until something names it, so every caller gets
 * `aria-hidden` and has to put the meaning in text of its own.
 */
function load(name: string, className: string): SafeHtml {
  const svg = ICONS[name]

  if (!svg) {
    // A missing icon is a blemish; a daemon that will not start is an outage.
    // Said once, at startup, where the log is read.
    process.stderr.write(
      `reviewd: icon "${name}" is not in icons.generated.ts, rendering without it\n`,
    )
    return raw('')
  }

  return raw(
    svg.replace('<svg ', `<svg class="${className}" width="14" height="14" aria-hidden="true" `),
  )
}

/** A source under version control. */
export const GIT_ICON = load('git-branch', 'vcs')

/** A source that is just a directory. */
export const FOLDER_ICON = load('folder', 'vcs')
