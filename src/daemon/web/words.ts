import { diffArrays } from 'diff'
import type { Row } from './hunks.js'

/**
 * Which words moved inside a changed block.
 *
 * A one-word edit renders as a whole line removed beside a whole line added,
 * and the reader finds the difference by eye. Marking the words that actually
 * changed is what `git diff --word-diff` does; this produces the ranges and
 * the renderer draws them.
 *
 * Whole blocks rather than paired lines. The obvious rule pairs the first
 * removed line with the first added line, and it finds nothing in the case
 * that prompted the feature: reflowing a markdown paragraph moves every word
 * left by a few columns, so line one against line one shares almost nothing
 * while the real edit is one word three lines down. Joining each side back
 * into the paragraph it came from puts the marks where the edit is.
 *
 * Words carry their own positions rather than being located afterwards by
 * offset. `diffWords` normalises whitespace, so its parts do not reconstruct
 * the input byte for byte — the first reflowed paragraph tried here came back
 * one character longer than it went in — and every offset after the first
 * drift would have been a guess. Diffing the words themselves means whitespace
 * cannot move a mark, and a pure reflow produces no marks at all, which is the
 * right answer for it.
 */

export interface Mark {
  /** Index into the block's own lines, not a file line number. */
  line: number
  /** Half-open character range within that line. */
  start: number
  end: number
}

export interface Marks {
  removed: Mark[]
  added: Mark[]
}

const NOTHING: Marks = { removed: [], added: [] }

/**
 * Blocks past this stay unmarked.
 *
 * The diff is O(n·d) in the number of words and the size of the difference, so
 * a large block that changed a lot is both the slowest case and the one where
 * marks say least. The limit is generous next to any hunk read in one go.
 */
const MAX_WORDS = 2000

/**
 * How much has to survive before marks are worth drawing.
 *
 * Below this the two sides are different text rather than an edit of the same
 * text, every other word takes a mark, and the result is louder than no marks
 * at all. Measured against the longer side, so replacing a paragraph with one
 * sentence does not count as mostly unchanged.
 */
const MIN_COMMON = 0.3

interface Word extends Mark {
  text: string
}

/** Every run of non-whitespace in the block, with where it sits. */
function wordsOf(lines: string[]): Word[] {
  const words: Word[] = []

  lines.forEach((text, line) => {
    for (const match of text.matchAll(/\S+/g)) {
      const start = match.index
      words.push({ text: match[0], line, start, end: start + match[0].length })
    }
  })

  return words
}

/**
 * The words that changed between a removed block and the added block replacing
 * it, as ranges within each side's own lines.
 *
 * Empty when either side is empty, when the blocks are too large, or when too
 * little survives for the comparison to mean anything.
 */
export function markChangedWords(removed: string[], added: string[]): Marks {
  if (removed.length === 0 || added.length === 0) return NOTHING

  const before = wordsOf(removed)
  const after = wordsOf(added)

  if (before.length === 0 || after.length === 0) return NOTHING
  if (before.length > MAX_WORDS || after.length > MAX_WORDS) return NOTHING

  const parts = diffArrays(
    before.map((word) => word.text),
    after.map((word) => word.text),
  )

  const removedMarks: Mark[] = []
  const addedMarks: Mark[] = []

  let beforeAt = 0
  let afterAt = 0
  let common = 0

  for (const part of parts) {
    const count = part.value.length

    if (part.added) {
      addedMarks.push(...runsOf(after.slice(afterAt, afterAt + count)))
      afterAt += count
      continue
    }

    if (part.removed) {
      removedMarks.push(...runsOf(before.slice(beforeAt, beforeAt + count)))
      beforeAt += count
      continue
    }

    common += count
    beforeAt += count
    afterAt += count
  }

  if (common / Math.max(before.length, after.length) < MIN_COMMON) return NOTHING

  // Nothing to say when the words are identical and only the wrapping moved,
  // which is the ordinary shape of a reformatted paragraph.
  if (removedMarks.length === 0 && addedMarks.length === 0) return NOTHING

  return { removed: removedMarks, added: addedMarks }
}

/**
 * One mark per line of a run of changed words, rather than one per word.
 *
 * A deleted phrase is a single edit, and marking its five words separately
 * drew five rounded chips with gaps between them where the spaces were. Only
 * whitespace can sit between two words of the same run, since a word is a run
 * of non-whitespace, so a mark can safely cover from the first to the last on
 * each line.
 */
function runsOf(words: Word[]): Mark[] {
  const marks: Mark[] = []

  for (const word of words) {
    const last = marks[marks.length - 1]

    if (last && last.line === word.line) last.end = word.end
    else marks.push({ line: word.line, start: word.start, end: word.end })
  }

  return marks
}

/** The marks that fall on one line of a block, in the order they appear. */
export function marksForLine(marks: Mark[], line: number): Mark[] {
  return marks.filter((entry) => entry.line === line).sort((a, b) => a.start - b.start)
}

/**
 * Every line of a file that carries marks, keyed the way a rendered half asks.
 *
 * A half knows which side it is on and which line number it holds, and nothing
 * about the block it came from, so the block index the marks carry is resolved
 * here and the renderer looks up one key.
 */
export type LineMarks = ReadonlyMap<string, Mark[]>

export function lineMarkKey(side: 'old' | 'new', line: number): string {
  return `${side}:${line}`
}

/**
 * Walks the rows of a file and marks each removed block against the added
 * block that replaced it.
 *
 * A run of removals followed immediately by a run of additions is one edit,
 * which is the same pairing toSplitRows uses to put them opposite each other.
 * A run with nothing opposite it is a plain addition or deletion, and
 * markChangedWords reports nothing for it.
 */
export function markRows(rows: readonly Row[]): LineMarks {
  const marks = new Map<string, Mark[]>()

  let at = 0
  while (at < rows.length) {
    const start = at
    while (at < rows.length && rows[at]?.kind === 'removed') at += 1
    const removed = rows.slice(start, at)

    const addedFrom = at
    while (at < rows.length && rows[at]?.kind === 'added') at += 1
    const added = rows.slice(addedFrom, at)

    if (removed.length === 0 && added.length === 0) {
      at += 1 // a context line, which no block spans
      continue
    }

    const found = markChangedWords(
      removed.map((row) => row.text),
      added.map((row) => row.text),
    )

    collect(marks, 'old', removed, found.removed)
    collect(marks, 'new', added, found.added)
  }

  return marks
}

function collect(
  into: Map<string, Mark[]>,
  side: 'old' | 'new',
  rows: readonly Row[],
  marks: readonly Mark[],
): void {
  for (const mark of marks) {
    const line = side === 'old' ? rows[mark.line]?.oldLine : rows[mark.line]?.newLine
    if (line === null || line === undefined) continue

    const key = lineMarkKey(side, line)
    const existing = into.get(key)

    if (existing) existing.push(mark)
    else into.set(key, [mark])
  }
}
