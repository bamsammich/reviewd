import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from 'shiki'
import { escapeHtml, raw, type SafeHtml } from './html.js'

/**
 * Syntax highlighting for the diff.
 *
 * Three constraints shaped this, and they rule out the obvious approaches.
 *
 * It happens on the server. The page replaces its whole main element when the
 * agent writes (see the events route), so a client-side pass would have to
 * re-run on every update and would arrive after the reader is already looking
 * at plain text.
 *
 * It never takes HTML from the library. `codeToTokens` returns text and a
 * colour per token, and the markup is built here from `escapeHtml`. The
 * escaping contract in html.ts is that everything is escaped unless this file
 * says otherwise, and a highlighter that emitted markup would be a hole in it
 * for whatever an agent wrote.
 *
 * It tokenises whole files, not lines. A line inside a block comment or a
 * template literal cannot be coloured correctly on its own, and the diff shows
 * lines. Shiki returns one token array per line, so the rows index into that.
 */

const LIGHT = 'github-light'
const DARK = 'github-dark'

/** Lines beyond this stay plain. Past it the reader is scrolling, not reading. */
const MAX_LINES = 5000

const BY_EXTENSION: Record<string, BundledLanguage> = {
  bash: 'bash',
  c: 'c',
  cjs: 'javascript',
  css: 'css',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  cpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  jsx: 'jsx',
  kt: 'kotlin',
  lua: 'lua',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  php: 'php',
  plist: 'xml',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svg: 'xml',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
}

/** Files without an extension that are still worth colouring. */
const BY_NAME: Record<string, BundledLanguage> = {
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  dockerfile: 'docker',
  makefile: 'makefile',
}

export function languageFor(path: string): BundledLanguage | undefined {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  const byName = BY_NAME[name]
  if (byName) return byName

  // A dotfile like `.prettierrc` has no extension in the sense that matters.
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined

  const extension = name.slice(dot + 1)
  const language = BY_EXTENSION[extension]
  return language && language in bundledLanguages ? language : undefined
}

export interface Token {
  text: string
  light: string
  dark: string
}

let starting: Promise<Highlighter> | undefined
const ready = new Set<string>()

async function highlighterFor(language: BundledLanguage): Promise<Highlighter> {
  // One highlighter for the process, with grammars loaded as files call for
  // them. Loading every bundled language up front costs seconds; loading the
  // handful a review actually contains costs milliseconds.
  starting ??= createHighlighter({ themes: [LIGHT, DARK], langs: [] })
  const highlighter = await starting

  if (!ready.has(language)) {
    await highlighter.loadLanguage(language)
    ready.add(language)
  }

  return highlighter
}

/**
 * Cache keyed by blob id, which is the sha256 of the content.
 *
 * Every render of a review re-tokenises the same bytes, and the live-update
 * path re-renders on every agent message. Content addressing means a hit is
 * always correct, so the only question is how many to keep.
 */
const CACHE_LIMIT = 256
const cache = new Map<string, Token[][]>()

function remember(key: string, value: Token[][]): Token[][] {
  cache.set(key, value)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return value
}

/**
 * One token array per line, or undefined when this file should stay plain.
 *
 * `expectedLines` guards the one failure that would be worse than no
 * highlighting: colours landing on the wrong lines. The diff and the
 * highlighter split the text independently, and if they disagree about how
 * many lines there are, nothing here is trustworthy.
 */
export async function tokenize(
  text: string,
  language: BundledLanguage,
  expectedLines: number,
  blobId?: string,
): Promise<Token[][] | undefined> {
  if (text === '' || expectedLines > MAX_LINES) return undefined

  const key = blobId ? `${blobId}:${language}` : undefined
  if (key) {
    const hit = cache.get(key)
    if (hit) return hit.length === expectedLines ? hit : undefined
  }

  let lines: Token[][]
  try {
    const highlighter = await highlighterFor(language)
    const result = highlighter.codeToTokens(text, {
      lang: language,
      themes: { light: LIGHT, dark: DARK },
    })

    lines = result.tokens.map((line) =>
      line.map((token) => ({
        text: token.content,
        light: token.htmlStyle?.['color'] ?? '',
        dark: token.htmlStyle?.['--shiki-dark'] ?? '',
      })),
    )

    // Text ending in a newline gives the highlighter one more line than the
    // diff counts, because splitLines drops that empty tail. Same condition,
    // so drop it the same way rather than failing the alignment check below.
    if (text.endsWith('\n') && lines[lines.length - 1]?.length === 0) lines.pop()
  } catch {
    // A grammar that fails to load or throws on odd input is not worth failing
    // a page render over. The diff reads fine in plain text.
    return undefined
  }

  if (lines.length !== expectedLines) return undefined
  return key ? remember(key, lines) : lines
}

/**
 * Assigns a class per colour pair used on this page.
 *
 * Inline styles would be correct and six times the bytes: a single file here
 * used seven distinct colours across four thousand tokens. Classes also keep
 * the dark variant in the stylesheet, where the rest of the theme lives,
 * rather than repeating a custom property on every span.
 */
export class Palette {
  private readonly names = new Map<string, string>()

  classFor(token: Token): string | undefined {
    if (!token.light && !token.dark) return undefined

    const key = `${token.light}|${token.dark}`
    let name = this.names.get(key)
    if (!name) {
      name = `hl${this.names.size}`
      this.names.set(key, name)
    }

    return name
  }

  /** The rules for every colour this page actually used, and no others. */
  css(): string {
    if (this.names.size === 0) return ''

    const light: string[] = []
    const dark: string[] = []

    for (const [key, name] of this.names) {
      const [lightColor = '', darkColor = ''] = key.split('|')
      if (lightColor) light.push(`.${name}{color:${lightColor}}`)
      if (darkColor) dark.push(`.${name}{color:${darkColor}}`)
    }

    return [
      light.join(''),
      dark.length > 0 ? `@media (prefers-color-scheme: dark){${dark.join('')}}` : '',
    ].join('')
  }
}

/** One line of code as spans, escaped here rather than anywhere else. */
export function renderLine(tokens: Token[], palette: Palette): SafeHtml {
  let out = ''

  for (const token of tokens) {
    const name = palette.classFor(token)
    out += name
      ? `<span class="${name}">${escapeHtml(token.text)}</span>`
      : escapeHtml(token.text)
  }

  return raw(out)
}
