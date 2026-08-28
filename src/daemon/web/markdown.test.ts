import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown.js'

const render = (body: string): string => renderMarkdown(body).value

/**
 * The subset a review comment uses, and the escaping that makes it safe.
 *
 * The safety cases matter more than the formatting ones. Comment bodies are
 * the one place text an agent wrote reaches the page, and the rest of the web
 * layer escapes by construction; a renderer that emits a tag it did not build
 * puts a hole in that.
 */
describe('what a comment cannot produce', () => {
  it('renders a script tag as text', () => {
    const out = render('<script>alert(1)</script>')

    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('renders an img with an onerror as text', () => {
    expect(render('<img src=x onerror=alert(1)>')).not.toContain('<img')
  })

  it('leaves a javascript: link as the text somebody typed', () => {
    const out = render('[click](javascript:alert(1))')

    expect(out).not.toContain('href')
    expect(out).toContain('[click]')
  })

  it('leaves a data: link alone too', () => {
    expect(render('[x](data:text/html;base64,PHNjcmlwdD4=)')).not.toContain('href')
  })

  it('cannot break out of an href with a quote', () => {
    const out = render('[x](/ok" onmouseover="alert(1))')

    expect(out).not.toContain('onmouseover="alert')
  })

  it('escapes an ampersand once, not twice', () => {
    expect(render('a & b')).toContain('a &amp; b')
  })
})

describe('links that are allowed', () => {
  it('renders an https link', () => {
    const out = render('see [the spec](https://example.com/spec)')

    expect(out).toContain('<a href="https://example.com/spec"')
    expect(out).toContain('rel="noopener noreferrer nofollow"')
    expect(out).toContain('>the spec</a>')
  })

  it('renders a site-relative link', () => {
    expect(render('[review](/r/abc)')).toContain('<a href="/r/abc"')
  })
})

describe('code, which is most of what a review comment does', () => {
  it('renders inline code', () => {
    expect(render('call `parseRawDiff` first')).toContain('<code>parseRawDiff</code>')
  })

  it('renders a fenced block and keeps its language', () => {
    const out = render('```ts\nconst a = 1\n```')

    expect(out).toContain('<pre class="code"><code class="language-ts">')
    expect(out).toContain('const a = 1')
  })

  it('renders a fenced block with no language', () => {
    expect(render('```\nplain\n```')).toContain('<pre class="code"><code>')
  })

  /** A snippet is reproduced, not formatted. */
  it('leaves markdown inside a fence alone', () => {
    const out = render('```\n**not bold** and *not italic*\n```')

    expect(out).not.toContain('<strong>')
    expect(out).not.toContain('<em>')
    expect(out).toContain('**not bold**')
  })

  it('leaves markdown inside inline code alone', () => {
    expect(render('`a ** b`')).toContain('<code>a ** b</code>')
  })

  it('escapes inside a fence', () => {
    expect(render('```\n<script>\n```')).toContain('&lt;script&gt;')
  })

  it('bolds a code span, which a review comment does constantly', () => {
    // Emphasis used to run between code spans rather than across them, so the
    // asterisks on either side never paired and printed themselves.
    const out = render('**`sideBytes`** reads like a getter')

    expect(out).toContain('<strong><code>sideBytes</code></strong>')
    expect(out).not.toContain('**')
  })

  it('keeps two code spans apart', () => {
    const out = render('`one` and `two`')

    expect(out).toContain('<code>one</code>')
    expect(out).toContain('<code>two</code>')
  })

  it('cannot be tricked by a placeholder somebody typed', () => {
    const out = render('\u0000 0 \u0000 and `real`')

    expect(out).toContain('<code>real</code>')
    expect(out).not.toContain('\u0000')
  })
})

describe('the rest of the subset', () => {
  it('renders a bullet list', () => {
    const out = render('- one\n- two')

    expect(out).toBe('<ul><li>one</li><li>two</li></ul>')
  })

  it('renders a numbered list', () => {
    expect(render('1. first\n2. second')).toBe('<ol><li>first</li><li>second</li></ol>')
  })

  it('does not merge a bullet list into a numbered one', () => {
    const out = render('- a\n1. b')

    expect(out).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>')
  })

  it('renders bold and italic', () => {
    expect(render('**very** and *slightly*')).toBe(
      '<p><strong>very</strong> and <em>slightly</em></p>',
    )
  })

  it('leaves an underscore inside a word alone', () => {
    // snake_case names are commoner in a code review than italics are.
    expect(render('call some_helper_name now')).not.toContain('<em>')
  })

  it('renders a quote', () => {
    expect(render('> they said this')).toBe('<blockquote>they said this</blockquote>')
  })

  it('splits paragraphs on a blank line', () => {
    expect(render('one\n\ntwo')).toBe('<p>one</p><p>two</p>')
  })

  it('keeps a single newline as a break', () => {
    expect(render('one\ntwo')).toBe('<p>one<br />two</p>')
  })

  it('renders plain text as one paragraph', () => {
    expect(render('nothing special here')).toBe('<p>nothing special here</p>')
  })

  it('renders an empty body as nothing', () => {
    expect(render('')).toBe('')
  })
})
