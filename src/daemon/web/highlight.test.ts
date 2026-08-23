import { describe, expect, it } from 'vitest'
import { splitLines } from './hunks.js'
import { languageFor, Palette, renderLine, tokenize, type Token } from './highlight.js'

describe('picking a language', () => {
  it('reads the extension', () => {
    expect(languageFor('src/a.ts')).toBe('typescript')
    expect(languageFor('deep/path/to/thing.py')).toBe('python')
    expect(languageFor('a.YAML')).toBe('yaml')
  })

  it('knows a few files that carry no extension', () => {
    expect(languageFor('Makefile')).toBe('makefile')
    expect(languageFor('docker/Dockerfile')).toBe('docker')
  })

  it('leaves a dotfile alone rather than reading its name as an extension', () => {
    expect(languageFor('.prettierrc')).toBeUndefined()
    expect(languageFor('.gitignore')).toBeUndefined()
  })

  it('gives up on anything it does not know, which renders plain', () => {
    expect(languageFor('notes.xyzzy')).toBeUndefined()
    expect(languageFor('LICENSE')).toBeUndefined()
  })
})

describe('tokenising', () => {
  const lines = (text: string) => splitLines(text).length

  it('returns one token array per line the diff will render', async () => {
    const text = 'const a = 1\nconst b = 2\n'
    const tokens = await tokenize(text, 'typescript', lines(text))

    expect(tokens).toHaveLength(2)
    expect(tokens?.[0]?.map((t) => t.text).join('')).toBe('const a = 1')
  })

  // The highlighter counts a trailing newline as another line and the diff does
  // not. Left alone that disagreement would fail the alignment check below and
  // quietly turn highlighting off for every file that ends in a newline, which
  // is nearly all of them.
  it('agrees with the diff about line counts, newline or not', async () => {
    for (const text of ['a = 1\nb = 2\n', 'a = 1\nb = 2', 'a = 1\n\nb = 2\n']) {
      expect(await tokenize(text, 'python', lines(text))).toHaveLength(lines(text))
    }
  })

  // Colours landing on the wrong lines would be worse than none at all, so a
  // disagreement about line counts turns the file plain instead.
  it('gives up rather than risk colouring the wrong lines', async () => {
    expect(await tokenize('const a = 1\n', 'typescript', 99)).toBeUndefined()
  })

  it('leaves empty text alone', async () => {
    expect(await tokenize('', 'typescript', 0)).toBeUndefined()
  })

  it('keeps a block comment coloured across its lines', async () => {
    const text = '/*\n comment\n*/\nconst a = 1\n'
    const tokens = await tokenize(text, 'typescript', lines(text))

    // The middle line is only a comment because of the line above it. A
    // per-line highlighter would read it as an identifier.
    const middle = tokens?.[1]?.[0]
    const code = tokens?.[3]?.find((t) => t.text.includes('const'))
    expect(middle?.light).toBeTruthy()
    expect(code?.light).toBeTruthy()
    expect(middle?.light).not.toBe(code?.light)
  })
})

describe('rendering a line', () => {
  const palette = () => new Palette()

  // The escaping contract is that nothing reaches the page unescaped unless
  // the web layer built it. A highlighter that emitted its own markup would be
  // a hole in that for whatever an agent wrote.
  it('escapes token text rather than trusting it', () => {
    const tokens: Token[] = [
      { text: '<script>alert(1)</script>', light: '#111111', dark: '#eeeeee' },
    ]

    const html = renderLine(tokens, palette()).value

    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('escapes even when a token carries no colour', () => {
    const html = renderLine([{ text: '<b>', light: '', dark: '' }], palette()).value

    expect(html).toBe('&lt;b&gt;')
  })

  it('reuses one class per colour pair instead of repeating a style', () => {
    const p = palette()
    const a: Token = { text: 'a', light: '#111111', dark: '#eeeeee' }
    const b: Token = { text: 'b', light: '#222222', dark: '#dddddd' }

    renderLine([a, b, { ...a, text: 'c' }], p)

    expect(p.css()).toContain('#111111')
    expect(p.css()).toContain('#222222')
    // Two colours seen, so two classes, even though three tokens were drawn.
    expect(p.css().match(/\.hl\d+\{color:#[0-9a-f]{6}\}/g)?.length).toBe(4)
  })
})

describe('the stylesheet it emits', () => {
  it('is empty when nothing was highlighted', () => {
    expect(new Palette().css()).toBe('')
  })

  it('puts the dark colours behind the same query the rest of the theme uses', () => {
    const p = new Palette()
    renderLine([{ text: 'a', light: '#111111', dark: '#eeeeee' }], p)

    const css = p.css()
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css.indexOf('#111111')).toBeLessThan(css.indexOf('@media'))
    expect(css.indexOf('#eeeeee')).toBeGreaterThan(css.indexOf('@media'))
  })
})
