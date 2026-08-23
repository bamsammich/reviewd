import { describe, expect, it } from 'vitest'
import { escapeHtml, html, raw } from './html.js'
import { anchorLineFor, buildRows, splitLines, toHunks } from './hunks.js'

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
