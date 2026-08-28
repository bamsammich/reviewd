import { escapeHtml, raw, type SafeHtml } from './html.js'

/**
 * The markdown a review comment actually uses.
 *
 * People type backticks around a symbol, fence a corrected snippet, and list
 * three things. Everything here serves one of those; nothing here is a general
 * markdown implementation, and the omissions are the point. Tables, images,
 * footnotes and raw HTML all stay literal text.
 *
 * Escaping runs first, over the whole body, and every tag below is one this
 * file wrote. That ordering is what makes the subset safe rather than the
 * regexes: a comment cannot produce a tag, only text that this file then wraps.
 */

/** Schemes a link may use. Anything else renders as text, `javascript:` included. */
const SAFE_LINK = /^(https?:\/\/|mailto:|\/)/i

/**
 * Stands in for a code span while emphasis runs.
 *
 * A control character rather than a word, because it has to be something the
 * body cannot contain: `renderMarkdown` strips it from the input first, so a
 * comment cannot forge one and reach into the span list.
 */
const HOLD = '\u0000'

export function renderMarkdown(body: string): SafeHtml {
  const escaped = escapeHtml(body.replace(/\r\n/g, '\n').replaceAll(HOLD, ''))
  return raw(blocks(escaped))
}

/**
 * Splits on fenced blocks first, so nothing inside one is read as markup.
 *
 * A comment pasting a corrected snippet is the common case, and a snippet full
 * of asterisks and underscores would otherwise come out italicised.
 */
function blocks(text: string): string {
  const out: string[] = []
  const fence = /^```([A-Za-z0-9+#._-]*)\n([\s\S]*?)(?:\n)?^```[ \t]*$/gm
  let at = 0

  for (const match of text.matchAll(fence)) {
    const start = match.index
    if (start > at) out.push(prose(text.slice(at, start)))

    const language = match[1] ?? ''
    const code = match[2] ?? ''
    const attribute = language ? ` class="language-${language}"` : ''
    out.push(`<pre class="code"><code${attribute}>${code}\n</code></pre>`)

    at = start + match[0].length
  }

  if (at < text.length) out.push(prose(text.slice(at)))
  return out.join('')
}

/** Paragraphs, lists and quotes, over text that carries no fences. */
function prose(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let paragraph: string[] = []
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null
  let quote: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    out.push(`<p>${inline(paragraph.join('\n'))}</p>`)
    paragraph = []
  }

  const flushList = (): void => {
    if (!list) return
    const items = list.items.map((item) => `<li>${inline(item)}</li>`).join('')
    out.push(`<${list.kind}>${items}</${list.kind}>`)
    list = null
  }

  const flushQuote = (): void => {
    if (quote.length === 0) return
    out.push(`<blockquote>${inline(quote.join('\n'))}</blockquote>`)
    quote = []
  }

  const flushAll = (): void => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (const line of lines) {
    const bullet = /^[ \t]*[-*][ \t]+(.*)$/.exec(line)
    const numbered = /^[ \t]*\d+\.[ \t]+(.*)$/.exec(line)
    const quoted = /^[ \t]*&gt;[ \t]?(.*)$/.exec(line)

    if (bullet || numbered) {
      flushParagraph()
      flushQuote()
      const kind = bullet ? 'ul' : 'ol'
      if (list && list.kind !== kind) flushList()
      list ??= { kind, items: [] }
      list.items.push((bullet ?? numbered)?.[1] ?? '')
      continue
    }

    if (quoted) {
      flushParagraph()
      flushList()
      quote.push(quoted[1] ?? '')
      continue
    }

    if (line.trim() === '') {
      flushAll()
      continue
    }

    flushList()
    flushQuote()
    paragraph.push(line)
  }

  flushAll()
  return out.join('')
}

/**
 * Inline code first, and its contents are then left alone.
 *
 * `**` inside a span of code is two asterisks a reader typed on purpose, and
 * bolding it would corrupt the one thing a code span exists to reproduce.
 */
function inline(text: string): string {
  // Code spans come out first and go back last, standing in the meantime as a
  // character the body cannot contain. Running emphasis over the parts between
  // them instead left `**` on either side of a code span unpaired, so
  // **`name`** printed its own asterisks.
  const spans: string[] = []
  const held = text.replace(/`([^`\n]+)`/g, (_whole, code: string) => {
    spans.push(code)
    return `${HOLD}${spans.length - 1}${HOLD}`
  })

  return emphasis(held)
    .replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_whole, index: string) => {
      return `<code>${spans[Number(index)] ?? ''}</code>`
    })
    .replace(/\n/g, '<br />')
}

function emphasis(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) =>
      SAFE_LINK.test(href)
        ? `<a href="${href}" rel="noopener noreferrer nofollow">${label}</a>`
        : whole,
    )
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>')
}
