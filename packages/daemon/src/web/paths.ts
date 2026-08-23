/**
 * Making a filesystem path readable at a glance.
 *
 * A reviewer needs to know which repository they are looking at, and an
 * absolute path is the worst possible way to tell them: the part that
 * identifies it sits at the end, behind a prefix that is the same for
 * everything they own.
 */

/** Replaces the home directory with ~, which is how people say these paths. */
export function homeRelative(path: string, home: string | undefined): string {
  if (!home || home === '/') return path
  const trimmed = home.replace(/\/$/, '')

  if (path === trimmed) return '~'
  return path.startsWith(`${trimmed}/`) ? `~${path.slice(trimmed.length)}` : path
}

/**
 * Keeps the ends and elides the middle.
 *
 * The last segment names the repository and the first says where it lives, so
 * dropping from the middle costs the least. Segments are elided whole, because
 * half a directory name reads as a typo.
 */
export function shortenPath(path: string, maxLength = 40): string {
  if (path.length <= maxLength) return path

  const segments = path.split('/')
  if (segments.length <= 3) return path

  const last = segments[segments.length - 1] as string
  const first = segments[0] === '' ? '' : (segments[0] as string)

  // Grow the tail from the end until adding one more would break the budget.
  let tail = last
  for (let i = segments.length - 2; i > 0; i -= 1) {
    const candidate = `${segments[i] as string}/${tail}`
    if (`${first}/…/${candidate}`.length > maxLength) break
    tail = candidate
  }

  return `${first}/…/${tail}`
}

/** What a source chip shows: short enough to scan, with the full path kept. */
export function displayPath(path: string, home = process.env['HOME'], maxLength = 40): string {
  return shortenPath(homeRelative(path, home), maxLength)
}

/** The directory name a repository is usually called by. */
export function basenameOf(path: string): string {
  const segments = path.replace(/\/$/, '').split('/')
  return segments[segments.length - 1] || path
}
