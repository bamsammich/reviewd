import type { MiddlewareHandler } from 'hono'
import { isLoopbackHost, stripPort, type ResolvedConfig } from '../config.js'

/**
 * The daemon holds no credentials, so the checks here are not about who is
 * asking. They are about a page in an open browser asking on the reviewer's
 * behalf, which is the attack a service bound to loopback actually faces.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Routes where a page token is demanded, so the origin need not be trusted.
 *
 * Every mutating route under `/r/` reads a token minted into the form it came
 * from; `routes-web.ts` refuses without one. That is a stronger answer than any
 * header, which is why these can afford to accept an origin the browser will
 * not name.
 *
 * A new `/r/` route that forgets its token would inherit this leniency without
 * earning it. `authority.test.ts` walks the mutating web routes and asserts each
 * one refuses an untokened request, so the omission fails a test rather than
 * quietly widening this.
 */
function tokenGuarded(path: string): boolean {
  return path.startsWith('/r/')
}

/**
 * Refuses any request addressed to a name the daemon does not answer to.
 *
 * This closes DNS rebinding: a hostile name whose record points at 127.0.0.1
 * lets a page in the browser treat the daemon as same-origin, and the Host
 * header is the one part of that the attacker cannot forge away.
 */
export function hostAllowlist(config: ResolvedConfig): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host')
    if (!host) {
      return c.json({ error: 'missing Host header' }, 400)
    }

    const name = stripPort(host).toLowerCase()
    if (!config.allowedHosts.has(name)) {
      return c.json(
        {
          error: `reviewd does not answer to host "${name}". Reach it at ${config.publicUrl}.`,
        },
        421,
      )
    }

    await next()
  }
}

/**
 * Requires a same-origin fetch for anything that changes state.
 *
 * Sec-Fetch-Site is set by the browser and cannot be spoofed from script. A
 * request without it came from something that is not a browser, and those are
 * checked against Origin instead so curl and the reviewd client keep working.
 */
export function crossSiteGuard(config: ResolvedConfig): MiddlewareHandler {
  return async (c, next) => {
    if (!MUTATING.has(c.req.method)) {
      await next()
      return
    }

    const site = c.req.header('sec-fetch-site')
    if (site) {
      if (site !== 'same-origin' && site !== 'none') {
        return c.json({ error: `cross-site ${c.req.method} refused` }, 403)
      }
      await next()
      return
    }

    const origin = c.req.header('origin')

    // `null` is an origin the browser declines to name: an in-app webview, a
    // sandboxed frame, a document reached through a redirect. It says nothing
    // about whether the request is hostile — a reviewer opening the review from
    // a notification looks exactly like a sandboxed frame from here.
    //
    // So it is tolerated only where something better is already being checked.
    // The pages demand a token minted into the form, which answers the question
    // this header was a proxy for; the API demands nothing, because the agent
    // and the commit hook hold no token, and `release` deletes a review. On
    // those an unnamed origin is the only signal there is, and it is refused.
    if (origin === 'null') {
      if (!tokenGuarded(c.req.path)) {
        return c.json(
          { error: `${c.req.method} from an unnamed origin refused on an API route` },
          403,
        )
      }

      await next()
      return
    }

    if (origin) {
      let hostname: string
      try {
        hostname = new URL(origin).hostname.toLowerCase()
      } catch {
        return c.json({ error: `unreadable Origin ${JSON.stringify(origin)}` }, 403)
      }
      if (!config.allowedHosts.has(hostname)) {
        return c.json({ error: `cross-origin ${c.req.method} refused` }, 403)
      }
    }

    await next()
  }
}

/**
 * Framing is the one browser attack the other two middlewares cannot see.
 *
 * A page framed cross-origin renders reviewd's own document, so a click on the
 * approve bar is genuinely same-origin and every check here passes it. Refusing
 * to be framed at all is the only place that stops.
 *
 * `unsafe-inline` covers the one style block and one script block the pages
 * emit. Both are server-built and neither carries review content, so the value
 * of this policy is `frame-ancestors` and `default-src`; a nonce would tighten
 * it but changes nothing about the attack above.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next()

    c.res.headers.set('x-frame-options', 'DENY')
    c.res.headers.set('x-content-type-options', 'nosniff')
    c.res.headers.set('referrer-policy', 'no-referrer')

    // Nothing here may be served from a cache unless it says otherwise.
    //
    // A review page carries the code under review, the revision it belongs to,
    // and a token minted for that revision. A phone that redraws a cached copy
    // shows all three as they were, which is the exact failure the live refresh
    // exists to prevent, arriving by a route the daemon never sees. Blobs opt
    // back in below: they are addressed by the hash of their own bytes and can
    // never change under an address.
    if (!c.res.headers.has('cache-control')) {
      c.res.headers.set('cache-control', 'no-store')
    }
    c.res.headers.set(
      'content-security-policy',
      [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "script-src 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    )
  }
}

/** Applied in order: what may reach us, then what it may do, then what it says. */
export function hardening(config: ResolvedConfig): MiddlewareHandler[] {
  return [securityHeaders(), hostAllowlist(config), crossSiteGuard(config)]
}

export { isLoopbackHost }
