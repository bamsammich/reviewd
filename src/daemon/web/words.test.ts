import { describe, expect, it } from 'vitest'
import { markChangedWords, marksForLine } from './words.js'

/** The text a mark covers, so a test reads as the words rather than as offsets. */
function marked(lines: string[], marks: { line: number; start: number; end: number }[]): string[] {
  return marks.map((mark) => (lines[mark.line] as string).slice(mark.start, mark.end))
}

describe('marking the words that changed', () => {
  it('finds a single word inside an otherwise identical line', () => {
    const before = ['start and reinstalls, and the new copy loads']
    const after = ['start and updates, and the new copy loads']

    const marks = markChangedWords(before, after)

    expect(marked(before, marks.removed)).toEqual(['reinstalls,'])
    expect(marked(after, marks.added)).toEqual(['updates,'])
  })

  /**
   * The case the feature exists for.
   *
   * Reflowing a paragraph moves every word left by a few columns, so pairing
   * the first removed line with the first added line finds nothing in common.
   * Two words changed here, and both sit on a different line of their side.
   */
  it('finds an edit inside a paragraph that was also rewrapped', () => {
    const before = [
      'That is the whole upgrade. The plugin is a separate artifact that Claude Code',
      'holds a copy of, so it would otherwise need a second command: the MCP server',
      'notices the mismatch on its next start and reinstalls, and the new copy loads',
    ]
    const after = [
      'The plugin is a separate artifact that Claude Code holds a copy of, so it would',
      'otherwise need a second command: the MCP server notices the mismatch on its next',
      'start and updates, and the new copy loads the session after.',
    ]

    const marks = markChangedWords(before, after)

    expect(marked(before, marks.removed)).toEqual(['That is the whole upgrade.', 'reinstalls,'])
    expect(marked(after, marks.added)).toEqual(['updates,', 'the session after.'])
  })

  // A deleted phrase is one edit. Marking its words separately drew a rounded
  // chip per word with a gap where each space was.
  it('covers a run of changed words with one mark', () => {
    const before = ['the daemon holds That is the whole upgrade. and nothing else at all here']
    const after = ['the daemon holds and nothing else at all here']

    const marks = markChangedWords(before, after)

    expect(marked(before, marks.removed)).toEqual(['That is the whole upgrade.'])
  })

  // Two edits with untouched words between them stay two marks, because the
  // gap holds text the reader is being told did not change.
  it('keeps two edits apart when an unchanged word sits between them', () => {
    const before = ['alpha beta gamma delta']
    const after = ['alpha BETA gamma DELTA']

    const marks = markChangedWords(before, after)

    expect(marked(after, marks.added)).toEqual(['BETA', 'DELTA'])
  })

  // Whitespace never carries a mark, so text that only moved reports nothing
  // and the reader is not told a line changed when its words did not.
  it('says nothing when only the wrapping moved', () => {
    const before = ['one two three', 'four five six']
    const after = ['one two', 'three four five six']

    expect(markChangedWords(before, after)).toEqual({ removed: [], added: [] })
  })

  it('says nothing when the two sides share too little to be an edit', () => {
    const before = ['the quick brown fox jumps over the lazy dog']
    const after = ['entirely different words appear here now instead']

    expect(markChangedWords(before, after)).toEqual({ removed: [], added: [] })
  })

  it('says nothing about a pure addition or a pure deletion', () => {
    expect(markChangedWords([], ['a new line'])).toEqual({ removed: [], added: [] })
    expect(markChangedWords(['an old line'], [])).toEqual({ removed: [], added: [] })
  })

  it('keeps a mark inside the line it belongs to', () => {
    const before = ['const a = 1', 'const b = 2']
    const after = ['const a = 1', 'const b = 3']

    const marks = markChangedWords(before, after)

    expect(marks.added).toEqual([{ line: 1, start: 10, end: 11 }])
    expect(marked(after, marks.added)).toEqual(['3'])
  })

  it('reports a line with no marks as having none', () => {
    const before = ['const a = 1', 'const b = 2']
    const after = ['const a = 1', 'const b = 3']

    const marks = markChangedWords(before, after)

    expect(marksForLine(marks.added, 0)).toEqual([])
    expect(marksForLine(marks.added, 1)).toHaveLength(1)
  })

  it('returns the marks on a line in the order they are read', () => {
    const before = ['alpha beta gamma delta']
    const after = ['alpha BETA gamma DELTA']

    const marks = markChangedWords(before, after)
    const line = marksForLine(marks.added, 0)

    expect(marked(after, line)).toEqual(['BETA', 'DELTA'])
  })

  // Indentation is whitespace, so a line that only moved right keeps its
  // columns correct rather than shifting every mark on it.
  it('measures columns from the start of the line, indentation included', () => {
    const before = ['    return a']
    const after = ['    return b']

    const marks = markChangedWords(before, after)

    expect(marks.added).toEqual([{ line: 0, start: 11, end: 12 }])
  })
})
