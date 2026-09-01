import type { Thread } from '../../protocol.js'
import { anchorForHalf, type Half } from './hunks.js'
import type { FileView } from './pages.js'

/**
 * Where a comment sits in a review.
 *
 * Five fields that only mean anything together: which source, which file,
 * which side of the diff, and which line or lines. They used to travel as
 * loose arguments and get compared field by field in five places, and the
 * comparisons drifted apart — one of them decided `side` by looking at whether
 * a row was an addition or a removal, which is unanswerable for a context line
 * that exists on both sides with a different number in each. That shipped as a
 * comment rendered twice and a comment stored against the wrong line.
 *
 * So the comparisons live here, written once.
 */
export interface Position {
  sourceId: string
  path: string
  side: 'old' | 'new'
  line: number
  /** Last line of a range, or null when the comment is on one line. */
  endLine: number | null
}

/** Where one half of a rendered row is, or nothing if it holds no line. */
export function positionAt(file: FileView, half: Half): Position | undefined {
  const anchor = anchorForHalf(half)
  if (!anchor) return undefined

  return {
    sourceId: file.sourceId,
    path: file.path,
    side: anchor.side,
    line: anchor.line,
    endLine: null,
  }
}

/** Where a thread sits, or undefined when it belongs to the review not a line. */
export function positionOfThread(thread: Thread): Position | undefined {
  if (
    thread.sourceId === null ||
    thread.path === null ||
    thread.side === null ||
    thread.line === null
  ) {
    return undefined
  }

  return {
    sourceId: thread.sourceId,
    path: thread.path,
    side: thread.side,
    line: thread.line,
    endLine: thread.endLine,
  }
}

/** Whether this thread is about the review rather than about a line. */
export function isReviewLevel(thread: Thread): boolean {
  return thread.path === null
}

/** Same file and same side, whatever lines are involved. */
export function inSameFile(one: Position, other: Position): boolean {
  return one.sourceId === other.sourceId && one.path === other.path && one.side === other.side
}

/** The same place: same file, same side, same starting line. */
export function samePlace(one: Position, other: Position): boolean {
  return inSameFile(one, other) && one.line === other.line
}

/**
 * The line a comment is drawn below: the last one it covers, not the first.
 *
 * A note about lines 40 to 44 drawn under line 40 splits the block it is
 * about, so the reader meets the note before four of the five lines it
 * discusses and has to read past it to reach them. Under line 44 the block
 * stays whole above the note, which is the order the sentence was written in.
 *
 * Separate from samePlace, which answers where a comment starts. Both
 * questions are real: the start is where a comment is anchored and re-anchored
 * across snapshots, and this is only where it is drawn.
 */
export function anchorLine(position: Position): number {
  return position.endLine ?? position.line
}

/** Whether a comment is drawn directly below this row. */
export function hangsBelow(comment: Position, row: Position): boolean {
  return inSameFile(comment, row) && anchorLine(comment) === row.line
}

/**
 * Whether a range takes in a point.
 *
 * A position with no end covers only itself, which is what makes a one-line
 * comment and a one-line range the same thing to every caller.
 */
export function covers(range: Position, point: Position): boolean {
  if (!inSameFile(range, point)) return false

  return point.line >= range.line && point.line <= (range.endLine ?? range.line)
}

/**
 * The form a position takes in a URL.
 *
 * Path goes last and keeps its colons, since it is the only field that can
 * contain one.
 */
export function positionKey(position: Position): string {
  return `${position.sourceId}:${position.side}:${position.line}:${position.path}`
}

/**
 * Reads a position back out of a URL.
 *
 * The end arrives separately as `to`, and is dropped unless it is a line below
 * the start, so a hand-edited URL cannot make a backwards or zero-length
 * range.
 */
export function parsePosition(
  value: string | undefined,
  to?: string | undefined,
): Position | undefined {
  if (!value) return undefined

  const [sourceId, side, line, ...pathParts] = value.split(':')
  const path = pathParts.join(':')

  if (!sourceId || !path || (side !== 'old' && side !== 'new')) return undefined

  const start = Number(line)
  if (!Number.isInteger(start) || start < 1) return undefined

  const end = Number(to)
  const endLine = to !== undefined && Number.isInteger(end) && end > start ? end : null

  return { sourceId, path, side, line: start, endLine }
}
