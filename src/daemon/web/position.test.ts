import type { Thread } from '../../protocol.js'
import { describe, expect, it } from 'vitest'
import { buildRows, toSplitRows } from './hunks.js'
import type { FileView } from './pages.js'
import {
  covers,
  inSameFile,
  parsePosition,
  positionAt,
  positionKey,
  positionOfThread,
  samePlace,
  type Position,
} from './position.js'

const at = (overrides: Partial<Position> = {}): Position => ({
  sourceId: 'src-1',
  path: 'src/a.ts',
  side: 'new',
  line: 4,
  endLine: null,
  ...overrides,
})

describe('the same place', () => {
  it('is the same file, side and line', () => {
    expect(samePlace(at(), at())).toBe(true)
  })

  it('is not the same line in another file', () => {
    expect(samePlace(at(), at({ path: 'src/b.ts' }))).toBe(false)
    expect(samePlace(at(), at({ sourceId: 'src-2' }))).toBe(false)
  })

  // The bug that made this module: line 4 of the old file and line 4 of the
  // new file are different places, and a comparison that forgets the side
  // renders one comment in both.
  it('is not the same line on the other side', () => {
    expect(samePlace(at({ side: 'old' }), at({ side: 'new' }))).toBe(false)
  })

  it('ignores how far a range reaches', () => {
    expect(samePlace(at({ endLine: 9 }), at())).toBe(true)
  })
})

describe('covering a line', () => {
  const block = at({ line: 4, endLine: 8 })

  it('takes in both ends and everything between', () => {
    for (const line of [4, 5, 8]) {
      expect(covers(block, at({ line }))).toBe(true)
    }
  })

  it('stops at the ends', () => {
    expect(covers(block, at({ line: 3 }))).toBe(false)
    expect(covers(block, at({ line: 9 }))).toBe(false)
  })

  it('covers only itself without an end', () => {
    expect(covers(at({ line: 4 }), at({ line: 4 }))).toBe(true)
    expect(covers(at({ line: 4 }), at({ line: 5 }))).toBe(false)
  })

  it('never reaches into another file or side', () => {
    expect(covers(block, at({ line: 5, path: 'src/b.ts' }))).toBe(false)
    expect(covers(block, at({ line: 5, side: 'old' }))).toBe(false)
  })
})

describe('a position in a URL', () => {
  it('survives the round trip', () => {
    const there = parsePosition(positionKey(at()))

    expect(there).toEqual(at())
  })

  it('keeps a path that contains a colon', () => {
    const odd = at({ path: 'src/weird:name.ts' })

    expect(parsePosition(positionKey(odd))).toEqual(odd)
  })

  it('carries a range in the separate argument', () => {
    expect(parsePosition(positionKey(at()), '9')).toEqual(at({ endLine: 9 }))
  })

  it('drops an end that is not below the start', () => {
    expect(parsePosition(positionKey(at()), '4')?.endLine).toBeNull()
    expect(parsePosition(positionKey(at()), '1')?.endLine).toBeNull()
    expect(parsePosition(positionKey(at()), 'soon')?.endLine).toBeNull()
  })

  it('refuses a key it cannot read', () => {
    expect(parsePosition(undefined)).toBeUndefined()
    expect(parsePosition('')).toBeUndefined()
    expect(parsePosition('src-1:sideways:4:src/a.ts')).toBeUndefined()
    expect(parsePosition('src-1:new:0:src/a.ts')).toBeUndefined()
    expect(parsePosition('src-1:new:4:')).toBeUndefined()
  })
})

describe('where a rendered row is', () => {
  const file = {
    sourceId: 'src-1',
    path: 'src/a.ts',
    oldText: 'a\nb\nc\n',
    newText: 'a\nINSERTED\nb\nc\n',
  } as FileView

  const rows = () => toSplitRows(buildRows(file.oldText, file.newText))

  // Each column reports the file its own numbering belongs to. Deriving that
  // from whether a row was added or removed cannot work for a context line,
  // which is in both files under different numbers.
  it('reads each column against its own file', () => {
    const b = rows().find((row) => row.left.text === 'b' && row.left.kind === 'context')!

    expect(positionAt(file, b.left)).toMatchObject({ side: 'old', line: 2 })
    expect(positionAt(file, b.right)).toMatchObject({ side: 'new', line: 3 })
  })

  it('gives no position to a blank half', () => {
    const inserted = rows().find((row) => row.right.text === 'INSERTED')!

    expect(positionAt(file, inserted.left)).toBeUndefined()
  })

  it('never puts two halves in the same place', () => {
    const places = rows()
      .flatMap((row) => [positionAt(file, row.left), positionAt(file, row.right)])
      .filter((place) => place !== undefined)
      .map(positionKey)

    expect(new Set(places).size).toBe(places.length)
  })
})

describe('where a thread is', () => {
  const thread = (overrides: Partial<Thread> = {}) =>
    ({ sourceId: 'src-1', path: 'src/a.ts', side: 'new', line: 4, endLine: null, ...overrides }) as Thread

  it('carries its range', () => {
    expect(positionOfThread(thread({ endLine: 8 }))).toEqual(at({ endLine: 8 }))
  })

  it('sits in the same file as a row it belongs to', () => {
    expect(inSameFile(positionOfThread(thread()), at({ line: 99 }))).toBe(true)
  })
})
