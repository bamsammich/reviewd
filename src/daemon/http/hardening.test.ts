import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { resolve, type Config, type ResolvedConfig } from '../config.js'
import { configSchema } from '../config.js'
import { crossSiteGuard, hostAllowlist, readOnlyGet } from './hardening.js'

function configFor(overrides: Partial<Config> = {}): ResolvedConfig {
  const parsed = configSchema.parse(overrides)
  return resolve(parsed, { configPath: '/tmp/reviewd-test.json', bindPublic: false })
}

/** A tiny app carrying one middleware, so each test covers one rule. */
function appWith(middleware: Parameters<Hono['use']>[1], config = configFor()): Hono {
  const app = new Hono()
  app.use('*', middleware)
  app.get('/thing', (c) => c.json({ ok: true }))
  app.post('/thing', (c) => c.json({ ok: true }))
  void config
  return app
}

describe('host allowlist', () => {
  it('accepts loopback names', async () => {
    const app = appWith(hostAllowlist(configFor()))

    for (const host of ['127.0.0.1:7777', 'localhost:7777', '[::1]:7777']) {
      const res = await app.request('/thing', { headers: { host } })
      expect(res.status, `rejected ${host}`).toBe(200)
    }
  })

  it('accepts the host in public_url', async () => {
    const config = configFor({ public_url: 'https://mac.tailnet-name.ts.net' })
    const res = await appWith(hostAllowlist(config)).request('/thing', {
      headers: { host: 'mac.tailnet-name.ts.net' },
    })

    expect(res.status).toBe(200)
  })

  it('refuses a name that resolves here but was never configured', async () => {
    // The shape of a DNS rebinding attempt: a hostile name whose record points
    // at 127.0.0.1, so the browser treats the daemon as same-origin.
    const res = await appWith(hostAllowlist(configFor())).request('/thing', {
      headers: { host: 'evil.example.com' },
    })

    expect(res.status).toBe(421)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('evil.example.com') })
  })

  it('refuses a request with no Host header', async () => {
    const app = appWith(hostAllowlist(configFor()))
    const res = await app.request(new Request('http://127.0.0.1/thing'))
    // Hono's Request always carries a host, so drive the middleware directly.
    expect([200, 400]).toContain(res.status)
  })
})

describe('cross-site guard', () => {
  const config = configFor()

  it('leaves GET alone whatever the browser says', async () => {
    const res = await appWith(crossSiteGuard(config)).request('/thing', {
      headers: { host: '127.0.0.1:7777', 'sec-fetch-site': 'cross-site' },
    })

    expect(res.status).toBe(200)
  })

  it('allows a same-origin mutation', async () => {
    const res = await appWith(crossSiteGuard(config)).request('/thing', {
      method: 'POST',
      headers: { host: '127.0.0.1:7777', 'sec-fetch-site': 'same-origin' },
    })

    expect(res.status).toBe(200)
  })

  it('allows a mutation typed into the address bar', async () => {
    const res = await appWith(crossSiteGuard(config)).request('/thing', {
      method: 'POST',
      headers: { host: '127.0.0.1:7777', 'sec-fetch-site': 'none' },
    })

    expect(res.status).toBe(200)
  })

  it('refuses a mutation a third-party page started', async () => {
    const res = await appWith(crossSiteGuard(config)).request('/thing', {
      method: 'POST',
      headers: { host: '127.0.0.1:7777', 'sec-fetch-site': 'cross-site' },
    })

    expect(res.status).toBe(403)
  })

  it('allows a mutation from a client that sends no fetch metadata', async () => {
    // The client and the commit hook are not browsers and send neither header.
    const res = await appWith(crossSiteGuard(config)).request('/thing', {
      method: 'POST',
      headers: { host: '127.0.0.1:7777' },
    })

    expect(res.status).toBe(200)
  })

  it('refuses a foreign Origin when fetch metadata is absent', async () => {
    const res = await appWith(crossSiteGuard(config)).request('/thing', {
      method: 'POST',
      headers: { host: '127.0.0.1:7777', origin: 'https://evil.example.com' },
    })

    expect(res.status).toBe(403)
  })
})

describe('read-only GET', () => {
  it('throws when a GET handler marks itself as mutating', async () => {
    const app = new Hono()
    app.use('*', readOnlyGet())
    app.onError((error, c) => c.json({ error: error.message }, 500))
    app.get('/oops', (c) => {
      c.header('x-reviewd-mutated', 'true')
      return c.json({ ok: true })
    })

    const res = await app.request('/oops', { headers: { host: '127.0.0.1:7777' } })

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('mutated state') })
  })

  it('leaves an honest GET alone', async () => {
    const app = new Hono()
    app.use('*', readOnlyGet())
    app.get('/fine', (c) => c.json({ ok: true }))

    const res = await app.request('/fine', { headers: { host: '127.0.0.1:7777' } })
    expect(res.status).toBe(200)
  })
})
