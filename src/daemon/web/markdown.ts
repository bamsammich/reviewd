import MarkdownIt from 'markdown-it'
import { raw, type SafeHtml } from './html.js'

/**
 * The markdown a review comment is written in.
 *
 * A hand-rolled subset came first, on the reasoning that a comment holds a
 * backtick, a fence and a short list. What a comment actually holds is
 * whatever the writer typed, and the subset then grew a case at a time: a
 * heading arrived as its own hashes, and a table as rows of pipes. Each
 * omission was a small decision, and the sum of them was a renderer that
 * disagreed with every other place the same person writes markdown.
 *
 * A parser answers the whole question once. What matters is which parser and
 * on what terms, because a comment is text one person wrote and another
 * person's browser renders.
 *
 * `html: false` is the safety story, and it is the whole of it: raw HTML in a
 * comment is escaped rather than passed through, so a comment cannot produce a
 * tag. Asserted in this file's tests against a script tag and an `img` with an
 * `onerror`, rather than taken from the documentation.
 *
 * Link schemes are markdown-it's own defaults: `javascript:`, `vbscript:`,
 * `file:` and `data:` are refused and left as the text somebody typed, while
 * http, https, mailto and site-relative links render. A quote inside an href
 * is percent-encoded, so an attribute cannot be broken out of.
 *
 * `linkify` stays off, so a bare URL in prose is text. Turning it on would
 * make a link of something nobody asked to be one, and a path or a hostname
 * inside a sentence about code is ordinary here.
 */
const md = new MarkdownIt({
  html: false,
  // A newline inside a paragraph is a line break, which is what the subset did
  // and what someone typing into a small box on a phone means by pressing
  // return. CommonMark would need two trailing spaces to say the same thing.
  breaks: true,
  linkify: false,
  typographer: false,
})

/**
 * Headings, moved under the page's own.
 *
 * A comment sits inside a document that already has an h1 and an h2, so a
 * comment's `#` would outrank the review's title in the outline a screen
 * reader reads out. Three levels are more than a comment needs, and every one
 * of them lands below the page's own structure.
 */
const HEADING: Record<string, string> = {
  h1: 'h4',
  h2: 'h5',
  h3: 'h6',
  h4: 'h6',
  h5: 'h6',
  h6: 'h6',
}

md.renderer.rules['heading_open'] = (tokens, index) =>
  `<${HEADING[tokens[index]?.tag ?? 'h6'] ?? 'h6'} class="ch">`

md.renderer.rules['heading_close'] = (tokens, index) =>
  `</${HEADING[tokens[index]?.tag ?? 'h6'] ?? 'h6'}>`

/**
 * External links carry `rel`, and site-relative ones do not need it.
 *
 * `noopener` and `noreferrer` describe a target this page never sets, and
 * `nofollow` describes a crawler that will never reach a review, so none of
 * the three does much work. They stay because a link an agent wrote into a
 * comment is the one place on this page where the href came from outside.
 */
type Rule = NonNullable<(typeof md.renderer.rules)[string]>

const renderToken: Rule = (tokens, index, options, _env, self) =>
  self.renderToken(tokens, index, options)

const defaultLink = md.renderer.rules['link_open'] ?? renderToken

md.renderer.rules['link_open'] = (tokens, index, options, env, self) => {
  const href = String(tokens[index]?.attrGet('href') ?? '')
  if (/^https?:/i.test(href)) tokens[index]?.attrSet('rel', 'noopener noreferrer nofollow')
  return defaultLink(tokens, index, options, env, self)
}

/** The class the stylesheet already dresses a fenced block with. */
const defaultFence = md.renderer.rules['fence'] ?? renderToken

md.renderer.rules['fence'] = (tokens, index, options, env, self) =>
  String(defaultFence(tokens, index, options, env, self)).replace(/^<pre>/, '<pre class="code">')

/**
 * A comment's body as HTML.
 *
 * Safe to insert because of `html: false` above, rather than because of
 * anything a caller does with the result.
 */
export function renderMarkdown(body: string): SafeHtml {
  return raw(md.render(body.replace(/\r\n/g, '\n')))
}
