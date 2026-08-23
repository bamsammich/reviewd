import type { MiddlewareHandler } from 'hono'
import { isLoopbackHost, stripPort, type ResolvedConfig } from '../config.js'

/**
 * The daemon holds no credentials, so the checks here are not about who is
 * asking. They are about a page in an open browser asking on the reviewer's
 * behalf, which is the attack a service bound to loopback actually faces.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

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
    if (origin) {
      let hostname: string
      try {
        hostname = new URL(origin).hostname.toLowerCase()
      } catch {
        return c.json({ error: 'malformed Origin' }, 403)
      }
      if (!config.allowedHosts.has(hostname)) {
        return c.json({ error: `cross-origin ${c.req.method} refused` }, 403)
      }
    }

    await next()
  }
}

/**
 * A GET must never change anything.
 *
 * Enforced as a rule rather than left to discipline, because the failure looks
 * like an image tag in an email approving a review.
 */
export function readOnlyGet(): MiddlewareHandler {
  return async (c, next) => {
    await next()

    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return
    if (c.res.headers.get('x-reviewd-mutated') !== 'true') return

    throw new Error(`reviewd bug: ${c.req.path} mutated state on a ${c.req.method}`)
  }
}

/** Applied in order: what may reach us, then what it may do. */
export function hardening(config: ResolvedConfig): MiddlewareHandler[] {
  return [hostAllowlist(config), crossSiteGuard(config), readOnlyGet()]
}

export { isLoopbackHost }
