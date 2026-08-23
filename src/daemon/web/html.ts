/**
 * A tagged template that escapes every interpolation.
 *
 * The pages here render file contents, comment bodies, and paths, all of which
 * are attacker-shaped in the sense that matters: a reviewer looks at whatever
 * an agent wrote. Escaping by default and opting out explicitly is the only
 * arrangement where forgetting is safe.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] as string)
}

/** Marks a string as already-safe HTML. Only ever wrap markup this file built. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value)
}

export type Renderable = SafeHtml | string | number | null | undefined | Renderable[]

function render(value: Renderable): string {
  if (value === null || value === undefined) return ''
  if (value instanceof SafeHtml) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  if (typeof value === 'number') return String(value)
  return escapeHtml(value)
}

export function html(strings: TemplateStringsArray, ...values: Renderable[]): SafeHtml {
  let out = strings[0] ?? ''

  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i])
    out += strings[i + 1] ?? ''
  }

  return new SafeHtml(out)
}

/** Attribute value for a URL, refusing anything that is not a plain path. */
export function safePath(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') ? value : '/'
}
