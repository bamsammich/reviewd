import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertBindAllowed,
  configSchema,
  isLoopbackHost,
  loadConfig,
  resolve,
  startupReport,
  stripPort,
} from './config.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reviewd-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(contents: unknown): string {
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(contents))
  return path
}

function configFor(overrides: Record<string, unknown> = {}) {
  return resolve(configSchema.parse(overrides), {
    configPath: join(dir, 'config.json'),
    bindPublic: false,
  })
}

describe('stripPort', () => {
  it('handles names, IPv4, and bracketed IPv6', () => {
    expect(stripPort('localhost:7777')).toBe('localhost')
    expect(stripPort('127.0.0.1:7777')).toBe('127.0.0.1')
    expect(stripPort('[::1]:7777')).toBe('[::1]')
    expect(stripPort('mac.tailnet.ts.net')).toBe('mac.tailnet.ts.net')
  })
})

describe('isLoopbackHost', () => {
  it('recognizes the loopback spellings', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]:7777', 'LOCALHOST:7777']) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
    for (const host of ['0.0.0.0', '192.168.1.5', 'mac.tailnet.ts.net']) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })
})

describe('defaults', () => {
  it('binds loopback on 7777 with no config file present', () => {
    const config = loadConfig({ configPath: join(dir, 'missing', 'config.json') })

    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(7777)
    expect(config.sweep.review_idle_days).toBe(14)
    expect(config.limits.max_blob_bytes).toBe(2 * 1024 * 1024)
  })

  it('writes a config file on first run, readable only by its owner', () => {
    const path = join(dir, 'fresh', 'config.json')
    loadConfig({ configPath: path })

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({})
  })

  it('falls back to the bind address when public_url is unset', () => {
    expect(configFor().publicUrl).toBe('http://127.0.0.1:7777')
  })

  it('keeps public_url when set, without a trailing slash', () => {
    const config = configFor({ public_url: 'https://mac.tailnet-name.ts.net/' })
    expect(config.publicUrl).toBe('https://mac.tailnet-name.ts.net')
  })
})

describe('validation', () => {
  it('refuses a malformed file rather than falling back to defaults', () => {
    const path = join(dir, 'config.json')
    writeFileSync(path, '{ not json')

    expect(() => loadConfig({ configPath: path })).toThrow(/cannot read/)
  })

  it('names the offending key when a value is wrong', () => {
    // A public_url typo is the expensive one: every link the agent hands over
    // dies, and nothing else looks broken.
    const path = write({ public_url: 'mac.tailnet-name.ts.net' })

    expect(() => loadConfig({ configPath: path })).toThrow(/public_url/)
  })

  it('refuses a port outside the range', () => {
    const path = write({ port: 99999 })
    expect(() => loadConfig({ configPath: path })).toThrow(/port/)
  })
})

describe('bind policy', () => {
  it('allows a loopback bind with no flag', () => {
    expect(() => assertBindAllowed(configFor(), false)).not.toThrow()
  })

  it('refuses a public bind that only the config file asked for', () => {
    expect(() => assertBindAllowed(configFor({ host: '0.0.0.0' }), false)).toThrow(/--bind-public/)
  })

  it('allows a public bind once the command line says so', () => {
    expect(() => assertBindAllowed(configFor({ host: '0.0.0.0' }), true)).not.toThrow()
  })
})

describe('startup report', () => {
  it('always states where links will point', () => {
    const lines = startupReport(configFor()).join('\n')
    expect(lines).toContain('http://127.0.0.1:7777')
  })

  it('warns when a public bind still hands out loopback links', () => {
    const lines = startupReport(configFor({ host: '0.0.0.0' })).join('\n')

    expect(lines).toMatch(/every link it hands out will be dead/)
    expect(lines).toMatch(/can route to this port/)
  })

  it('stays quiet about link addresses once public_url is set', () => {
    const lines = startupReport(
      configFor({ host: '0.0.0.0', public_url: 'https://mac.tailnet-name.ts.net' }),
    ).join('\n')

    expect(lines).not.toMatch(/every link it hands out will be dead/)
    expect(lines).toMatch(/can route to this port/)
  })
})

describe('allowed hosts', () => {
  it('covers loopback plus the public_url hostname', () => {
    const config = configFor({ public_url: 'https://mac.tailnet-name.ts.net' })

    expect(config.allowedHosts.has('127.0.0.1')).toBe(true)
    expect(config.allowedHosts.has('localhost')).toBe(true)
    expect(config.allowedHosts.has('mac.tailnet-name.ts.net')).toBe(true)
    expect(config.allowedHosts.has('evil.example.com')).toBe(false)
  })
})
