import { describe, expect, it } from 'vitest'
import { escapeHtml, html, raw } from './html.js'
import {
  anchorForHalf,
  anchorLineFor,
  buildRows,
  splitLines,
  toHunks,
  toSplitRows,
} from './hunks.js'

const before = ['one', 'two', 'three'].join('\n')

describe('buildRows', () => {
  it('numbers both sides through a modification', () => {
    const rows = buildRows(before, ['one', 'CHANGED', 'three'].join('\n'))

    expect(rows.map((r) => [r.kind, r.oldLine, r.newLine, r.text])).toEqual([
      ['context', 1, 1, 'one'],
      ['removed', 2, null, 'two'],
      ['added', null, 2, 'CHANGED'],
      ['context', 3, 3, 'three'],
    ])
  })

  it('numbers an insertion without disturbing the old side', () => {
    const rows = buildRows(before, ['one', 'inserted', 'two', 'three'].join('\n'))
    const added = rows.find((r) => r.kind === 'added')

    expect(added).toMatchObject({ oldLine: null, newLine: 2, text: 'inserted' })
    expect(rows.filter((r) => r.kind === 'context').at(-1)).toMatchObject({
      oldLine: 3,
      newLine: 4,
    })
  })

  it('reads an added file as all additions', () => {
    const rows = buildRows('', ['a', 'b'].join('\n'))

    expect(rows.every((r) => r.kind === 'added')).toBe(true)
    expect(rows).toHaveLength(2)
  })

  it('reads a deleted file as all removals', () => {
    const rows = buildRows(['a', 'b'].join('\n'), '')

    expect(rows.every((r) => r.kind === 'removed')).toBe(true)
  })

  it('reports nothing changed as all context', () => {
    expect(buildRows(before, before).every((r) => r.kind === 'context')).toBe(true)
  })
})

describe('toHunks', () => {
  it('collapses a long unchanged stretch', () => {
    // The case this exists for: one changed line in a big file should render
    // as a few rows, not the whole file with a highlight somewhere in it.
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`)
    const changed = [...lines]
    changed[100] = 'line 100 changed'

    const hunks = toHunks(buildRows(lines.join('\n'), changed.join('\n')))

    expect(hunks).toHaveLength(1)
    // Three context either side of a removal and an addition.
    expect(hunks[0]?.rows).toHaveLength(8)
  })

  it('splits changes that are far apart into separate hunks', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const changed = [...lines]
    changed[10] = 'changed early'
    changed[80] = 'changed late'

    expect(toHunks(buildRows(lines.join('\n'), changed.join('\n')))).toHaveLength(2)
  })

  it('joins changes that are close together', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const changed = [...lines]
    changed[10] = 'a'
    changed[12] = 'b'

    expect(toHunks(buildRows(lines.join('\n'), changed.join('\n')))).toHaveLength(1)
  })

  it('returns nothing when nothing changed', () => {
    expect(toHunks(buildRows(before, before))).toEqual([])
  })

  it('writes a header in the shape reviewers already read', () => {
    const hunks = toHunks(buildRows(before, ['one', 'CHANGED', 'three'].join('\n')))

    expect(hunks[0]?.header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/)
  })
})

describe('anchorLineFor', () => {
  it('anchors an addition and a context row to the new side', () => {
    expect(anchorLineFor({ kind: 'added', oldLine: null, newLine: 7, text: '' })).toEqual({
      side: 'new',
      line: 7,
    })
    expect(anchorLineFor({ kind: 'context', oldLine: 3, newLine: 5, text: '' })).toEqual({
      side: 'new',
      line: 5,
    })
  })

  it('anchors a removal to the old side, which is the only one it has', () => {
    expect(anchorLineFor({ kind: 'removed', oldLine: 9, newLine: null, text: '' })).toEqual({
      side: 'old',
      line: 9,
    })
  })
})

describe('splitLines', () => {
  it('drops the empty element a trailing newline leaves', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
  })
})

describe('html escaping', () => {
  it('escapes every interpolation', () => {
    const payload = '<script>alert(1)</script>'

    expect(html`<td>${payload}</td>`.value).toBe('<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>')
  })

  it('escapes quotes, so an attribute cannot be broken out of', () => {
    expect(escapeHtml(`" onload="evil()`)).toBe('&quot; onload=&quot;evil()')
  })

  it('leaves markup this file built alone', () => {
    expect(html`<div>${raw('<b>bold</b>')}</div>`.value).toBe('<div><b>bold</b></div>')
  })

  it('escapes inside arrays and nested templates', () => {
    // Asserted on the joined rows rather than a wrapping template, because
    // formatting a tagged template rewrites the literal parts and would make
    // this test about indentation instead of about escaping.
    const rows = ['<a>', '<b>'].map((text) => html`<li>${text}</li>`)

    expect(html`${rows}`.value).toBe('<li>&lt;a&gt;</li><li>&lt;b&gt;</li>')
  })
})

describe('toSplitRows', () => {
  const before = ['one', 'two', 'three'].join('\n')

  it('puts a context line on both sides and keeps the new one when stacked', () => {
    const [row] = toSplitRows(buildRows('only', 'only'))

    expect(row).toMatchObject({
      left: { kind: 'context', line: 1, text: 'only' },
      right: { kind: 'context', line: 1, text: 'only' },
      unified: 'right',
    })
  })

  it('pairs a removal with the addition that replaced it', () => {
    const rows = toSplitRows(buildRows(before, ['one', 'CHANGED', 'three'].join('\n')))
    const change = rows.find((row) => row.left.kind === 'removed')

    expect(change).toMatchObject({
      left: { text: 'two', line: 2 },
      right: { text: 'CHANGED', line: 2 },
      // Both halves survive a stack, because both are part of the edit.
      unified: 'both',
    })
  })

  it('pairs runs index by index and leaves the leftovers opposite a blank', () => {
    const rows = toSplitRows(buildRows(['a', 'b'].join('\n'), ['A', 'B', 'C'].join('\n')))

    expect(rows).toHaveLength(3)
    expect(rows[2]).toMatchObject({
      left: { kind: 'empty' },
      right: { kind: 'added', text: 'C' },
      unified: 'right',
    })
  })

  it('gives a pure addition an empty left half', () => {
    const rows = toSplitRows(buildRows(before, ['one', 'INSERTED', 'two', 'three'].join('\n')))
    const added = rows.find((row) => row.right.kind === 'added')

    expect(added?.left.kind).toBe('empty')
    expect(added?.unified).toBe('right')
  })

  it('does not paint a pair red and green when both halves read the same', () => {
    // Line diffing produces one of these when a file's last line has no
    // trailing newline, and rendering it tells a reviewer something untrue.
    const rows = toSplitRows(buildRows(before, ['one', 'two', 'three', 'four'].join('\n')))

    for (const row of rows) {
      if (row.left.text === row.right.text && row.left.kind !== 'empty') {
        expect(row.left.kind).toBe('context')
        expect(row.right.kind).toBe('context')
      }
    }
  })

  it('gives a pure deletion an empty right half', () => {
    const rows = toSplitRows(buildRows(before, ['one', 'three'].join('\n')))
    const removed = rows.find((row) => row.left.kind === 'removed')

    expect(removed?.right.kind).toBe('empty')
    expect(removed?.unified).toBe('left')
  })

  it('keeps every line, so the two sides stay aligned', () => {
    const rows = buildRows(before, ['one', 'CHANGED', 'three', 'four'].join('\n'))
    const split = toSplitRows(rows)

    const left = split.filter((row) => row.left.kind !== 'empty').length
    const right = split.filter((row) => row.right.kind !== 'empty').length

    expect(left).toBe(rows.filter((r) => r.oldLine !== null).length)
    expect(right).toBe(rows.filter((r) => r.newLine !== null).length)
  })
})

describe('anchorForHalf', () => {
  // This used to read the side off the kind, which is right for a removal and
  // an addition and wrong for context: a context line exists in both files
  // with a different number in each, so only the column knows which.
  it('anchors to the side the half is a column of', () => {
    expect(anchorForHalf({ kind: 'removed', line: 4, text: '', side: 'old' })).toEqual({
      side: 'old',
      line: 4,
    })
    expect(anchorForHalf({ kind: 'added', line: 4, text: '', side: 'new' })).toEqual({
      side: 'new',
      line: 4,
    })
    expect(anchorForHalf({ kind: 'context', line: 4, text: '', side: 'old' })).toEqual({
      side: 'old',
      line: 4,
    })
    expect(anchorForHalf({ kind: 'context', line: 9, text: '', side: 'new' })).toEqual({
      side: 'new',
      line: 9,
    })
  })

  it('refuses to anchor a blank half', () => {
    expect(anchorForHalf({ kind: 'empty', line: null, text: '', side: 'old' })).toBeNull()
  })
})

/**
 * The bug a reviewer actually saw: one comment rendered twice.
 *
 * An insertion pushes the new-side numbering ahead of the old, so after it the
 * two columns of a context row carry different line numbers. While both
 * columns claimed the new side, a comment on new line N matched the added row
 * at N and the context row whose *old* number was N, and the page drew it in
 * both places. The quieter half of the same fault: commenting on a left-column
 * context line filed it against the new side, which after an insertion is a
 * different line of code entirely.
 */
describe('an insertion shifting the two columns apart', () => {
  const rows = () => toSplitRows(buildRows('a\nb\nc\nd\n', 'a\nINSERTED\nb\nc\nd\n'))

  it('never gives two halves the same anchor', () => {
    const anchors = rows()
      .flatMap((row) => [anchorForHalf(row.left), anchorForHalf(row.right)])
      .filter((anchor) => anchor !== null)
      .map((anchor) => `${anchor.side}:${anchor.line}`)

    expect(new Set(anchors).size).toBe(anchors.length)
  })

  it('keeps each column pointing at its own file', () => {
    // Old line 2 and new line 3 are both "b"; new line 2 is the inserted line.
    const b = rows().find((row) => row.left.text === 'b' && row.left.kind === 'context')

    expect(anchorForHalf(b!.left)).toEqual({ side: 'old', line: 2 })
    expect(anchorForHalf(b!.right)).toEqual({ side: 'new', line: 3 })
  })
})
