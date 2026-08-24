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

  it('advertises local-only capabilities when it shares a disk with the code', async () => {
    const res = await app.request('/api/capabilities', { headers: LOOPBACK })

    expect(await res.json()).toMatchObject({ local: true, openInEditor: true, fileWatch: true })
  })

  it('reports the version the package actually says, not one typed by hand', async () => {
    const pkg = createRequire(import.meta.url)('../../../package.json') as { version: string }

    const res = await app.request('/api/capabilities', { headers: LOOPBACK })
    expect(await res.json()).toMatchObject({ version: pkg.version })
  })

  it('withholds them when it does not', async () => {
    const config = resolve(configSchema.parse({}), {
      configPath: '/tmp/reviewd-test.json',
      bindPublic: false,
    })
    const remote = createApp({ config, db: ctx.db, local: false })

    const res = await remote.request('/api/capabilities', { headers: LOOPBACK })
    expect(await res.json()).toMatchObject({ local: false, openInEditor: false, fileWatch: false })
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
