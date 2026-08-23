import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureDaemon, logPath } from './ensure.js'

const URL_LOCAL = 'http://127.0.0.1:7777'

/**
 * A daemon that comes up after `readyAfter` health checks, or never.
 *
 * Counting the checks is the point: it separates "answered straight away" from
 * "answered because we started it", which is the only distinction this module
 * makes.
 */
function fakeHealth(readyAfter: number | null) {
  let checks = 0

  const fetcher = vi.fn(async () => {
    checks += 1
    const up = readyAfter !== null && checks > readyAfter
    if (!up) throw new Error('ECONNREFUSED')
    return new Response('{"ok":true}', { status: 200 })
  })

  vi.stubGlobal('fetch', fetcher)
  return { checks: () => checks }
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('starting the daemon when nothing answers', () => {
  it('leaves a running daemon alone', async () => {
    fakeHealth(0)
    const spawn = vi.fn()

    expect(await ensureDaemon(URL_LOCAL, spawn)).toEqual({ running: true, started: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('starts one and waits for it to answer', async () => {
    fakeHealth(2)
    const spawn = vi.fn()

    expect(await ensureDaemon(URL_LOCAL, spawn)).toEqual({ running: true, started: true })
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('gives up rather than hanging when it never comes up', async () => {
    fakeHealth(null)
    const spawn = vi.fn()

    const result = await ensureDaemon(URL_LOCAL, spawn)

    expect(result.running).toBe(false)
    expect(result.error).toContain(URL_LOCAL)
  }, 15_000)

  it('reports a spawn that throws instead of waiting out the timeout', async () => {
    fakeHealth(null)
    const spawn = vi.fn(() => {
      throw new Error('spawn reviewd ENOENT')
    })

    const result = await ensureDaemon(URL_LOCAL, spawn)

    expect(result).toMatchObject({ running: false, started: false })
    expect(result.error).toContain('ENOENT')
  })

  // Starting a local process would not fix a base_url pointing at another
  // machine; it would just add a daemon that answers nobody.
  it('refuses to start anything for a base_url that is not this machine', async () => {
    fakeHealth(null)
    const spawn = vi.fn()

    const result = await ensureDaemon('http://reviewd.example.com:7777', spawn)

    expect(result).toMatchObject({ running: false, started: false })
    expect(result.error).toContain('not this machine')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('treats localhost and ::1 as this machine', async () => {
    for (const url of ['http://localhost:7777', 'http://[::1]:7777']) {
      fakeHealth(1)
      const spawn = vi.fn()

      expect(await ensureDaemon(url, spawn)).toMatchObject({ running: true, started: true })
      vi.unstubAllGlobals()
    }
  })
})

describe('where the log goes', () => {
  it('follows XDG_STATE_HOME when it is set', () => {
    vi.stubEnv('XDG_STATE_HOME', '/tmp/state')
    expect(logPath()).toBe('/tmp/state/reviewd/reviewd.log')
  })

  it('falls back to the path a service unit would write', () => {
    vi.stubEnv('XDG_STATE_HOME', '')
    expect(logPath()).toMatch(/\.local\/state\/reviewd\/reviewd\.log$/)
  })
})
