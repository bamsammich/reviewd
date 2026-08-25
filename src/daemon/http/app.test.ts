import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema, resolve } from '../config.js'
import { tempDatabase, type TempDatabase } from '../db/testing.js'
import { createApp, type App } from './app.js'

let ctx: TempDatabase
let app: App

const LOOPBACK = { host: '127.0.0.1:7777' }

beforeEach(async () => {
  ctx = await tempDatabase()
  const config = resolve(configSchema.parse({}), {
    configPath: '/tmp/reviewd-test.json',
    bindPublic: false,
  })
  app = createApp({ config, db: ctx.db, local: true })
})

afterEach(async () => {
  await ctx.close()
})

describe('app', () => {
  it('answers health', async () => {
    const res = await app.request('/api/health', { headers: LOOPBACK })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('says it shares a disk with the code when it does', async () => {
    const res = await app.request('/api/capabilities', { headers: LOOPBACK })

    expect(await res.json()).toMatchObject({ local: true })
  })

  /**
   * A capability is a promise, and these two were not kept.
   *
   * `openInEditor` and `fileWatch` were both answered `true` on a local daemon
   * and neither existed anywhere in the source. A client written against them
   * would have built a feature that did nothing at all, which is a worse
   * outcome than the feature being missing, because nothing fails.
   */
  it('advertises nothing it cannot do', async () => {
    const res = await app.request('/api/capabilities', { headers: LOOPBACK })
    const body = (await res.json()) as Record<string, unknown>

    expect(Object.keys(body).sort()).toEqual(['local', 'version'])
  })

  it('reports the version the package actually says, not one typed by hand', async () => {
    const pkg = createRequire(import.meta.url)('../../../package.json') as { version: string }

    const res = await app.request('/api/capabilities', { headers: LOOPBACK })
    expect(await res.json()).toMatchObject({ version: pkg.version })
  })

  it('says it does not when it shares no disk with the code', async () => {
    const config = resolve(configSchema.parse({}), {
      configPath: '/tmp/reviewd-test.json',
      bindPublic: false,
    })
    const remote = createApp({ config, db: ctx.db, local: false })

    const res = await remote.request('/api/capabilities', { headers: LOOPBACK })
    expect(await res.json()).toMatchObject({ local: false })
  })

  it('runs the hardening stack ahead of every route', async () => {
    const res = await app.request('/api/health', { headers: { host: 'evil.example.com' } })
    expect(res.status).toBe(421)
  })

  it('names the route in a 404 rather than returning an empty body', async () => {
    const res = await app.request('/api/nope', { headers: LOOPBACK })

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('/api/nope') })
  })
})
