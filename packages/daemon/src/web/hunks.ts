import { diffLines } from 'diff'

/**
 * Turning two versions of a file into rows a reviewer can read and click.
 *
 * Rows carry both line numbers because a comment anchors to one side. The old
 * number is what a deletion is addressed by, the new number is what everything
 * else is addressed by, and a context row has both.
 */

export type RowKind = 'context' | 'added' | 'removed'

export interface Row {
  kind: RowKind
  oldLine: number | null
  newLine: number | null
  text: string
}

export interface Hunk {
  /** Header in the shape reviewers already read from git. */
  header: string
  rows: Row[]
}

/** Context lines kept either side of a change, matching git's default. */
const CONTEXT = 3

export function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function buildRows(oldText: string, newText: string): Row[] {
  const rows: Row[] = []
  let oldLine = 1
  let newLine = 1

  for (const part of diffLines(oldText, newText)) {
    for (const text of splitLines(part.value)) {
      if (part.added) {
        rows.push({ kind: 'added', oldLine: null, newLine, text })
        newLine += 1
      } else if (part.removed) {
        rows.push({ kind: 'removed', oldLine, newLine: null, text })
        oldLine += 1
      } else {
        rows.push({ kind: 'context', oldLine, newLine, text })
        oldLine += 1
        newLine += 1
      }
    }
  }

  return rows
}

/**
 * Collapses untouched stretches into hunks.
 *
 * A file with one changed line in two thousand should render as a handful of
 * rows, not as the whole file with a highlight somewhere in it.
 */
export function toHunks(rows: Row[], context = CONTEXT): Hunk[] {
  const keep = new Set<number>()

  rows.forEach((row, index) => {
    if (row.kind === 'context') return
    for (let i = index - context; i <= index + context; i += 1) {
      if (i >= 0 && i < rows.length) keep.add(i)
    }
  })

  if (keep.size === 0) return []

  const hunks: Hunk[] = []
  let current: Row[] = []
  let previous = -2

  const flush = (): void => {
    if (current.length === 0) return
    hunks.push({ header: headerFor(current), rows: current })
    current = []
  }

  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index !== previous + 1) flush()
    current.push(rows[index] as Row)
    previous = index
  }

  flush()
  return hunks
}

function headerFor(rows: Row[]): string {
  const oldStart = rows.find((r) => r.oldLine !== null)?.oldLine ?? 0
  const newStart = rows.find((r) => r.newLine !== null)?.newLine ?? 0
  const oldCount = rows.filter((r) => r.oldLine !== null).length
  const newCount = rows.filter((r) => r.newLine !== null).length

  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
}

/** The line a comment on this row would anchor to. */
export function anchorLineFor(row: Row): { side: 'old' | 'new'; line: number } | null {
  if (row.newLine !== null) return { side: 'new', line: row.newLine }
  if (row.oldLine !== null) return { side: 'old', line: row.oldLine }
  return null
}
