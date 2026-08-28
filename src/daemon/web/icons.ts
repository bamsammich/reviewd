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
function load(name: string, className: string, size = 14): SafeHtml {
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
    svg.replace(
      '<svg ',
      `<svg class="${className}" width="${size}" height="${size}" aria-hidden="true" `,
    ),
  )
}

/** A source under version control. */
export const GIT_ICON = load('git-branch', 'vcs')

/** A source that is just a directory. */
export const FOLDER_ICON = load('folder', 'vcs')

/**
 * Start a comment on this line.
 *
 * Drawn rather than typed, because the character this used to be was `+`, and
 * `+` is already the diff's word for an added line. The two sat one column
 * apart: the control that is the whole point of the page wore the costume of
 * the syntax beside it, and on a removed line it contradicted the `-` next to
 * it. A speech bubble belongs to no diff notation and needs no legend.
 */
export const COMMENT_ICON = load('chat-teardrop-dots', 'ico', 13)

/** Pull a comment already being written down as far as this line. */
export const EXTEND_ICON = load('arrow-line-down', 'ico', 13)
