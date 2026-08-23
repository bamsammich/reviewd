import { spawn } from 'node:child_process'
import { openSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client } from './client.js'

/**
 * Starts the daemon if nothing is answering.
 *
 * Every command here needs a daemon, and asking a person to install a service
 * before they can use a tool is a step that exists only because the tool would
 * not start itself. So it starts itself: the first command that needs it brings
 * it up, and it stays up for the ones after.
 *
 * A launchd or systemd unit is still worth having, for starting at login rather
 * than on first use. It is no longer the difference between working and not.
 */

/** Long enough for a cold Node start, short enough to fail while someone is watching. */
const STARTUP_TIMEOUT_MS = 8000
const POLL_MS = 100

export function logPath(): string {
  // Empty counts as unset. An exported-but-blank XDG_STATE_HOME is common
  // enough, and honouring it literally would write the log to a relative path
  // under whatever directory the commit happened to run in.
  const state = process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state')
  return join(state, 'reviewd', 'reviewd.log')
}

export interface EnsureResult {
  running: boolean
  /** True when this call started it, which is worth saying once rather than never. */
  started: boolean
  error?: string
}

export async function ensureDaemon(
  baseUrl: string,
  spawnDaemon: () => void = spawnDetached,
): Promise<EnsureResult> {
  const client = new Client(baseUrl)
  if (await client.health()) return { running: true, started: false }

  // Only a daemon on this machine can be started from here. A base_url pointing
  // somewhere else is someone else's process, and guessing otherwise would
  // start a second daemon that answers nobody.
  if (!isLoopback(baseUrl)) {
    return { running: false, started: false, error: `${baseUrl} is not this machine` }
  }

  try {
    spawnDaemon()
  } catch (error) {
    return {
      running: false,
      started: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    if (await client.health()) return { running: true, started: true }
  }

  return { running: false, started: false, error: `nothing answered at ${baseUrl}` }
}

/**
 * Launches reviewd so it outlives this process.
 *
 * Detached and unref'd, because the caller is usually a one-shot command and a
 * daemon that dies with the commit hook that started it is no daemon. Output
 * goes to the same log a service unit would write, so there is one place to
 * look either way.
 */
function spawnDetached(): void {
  const log = logPath()
  mkdirSync(dirname(log), { recursive: true })
  const handle = openSync(log, 'a')

  const child = spawn('reviewd', ['serve'], {
    detached: true,
    stdio: ['ignore', handle, handle],
  })

  child.unref()
}

function isLoopback(baseUrl: string): boolean {
  try {
    // URL keeps the brackets on an IPv6 hostname, so [::1] arrives spelled
    // differently from every other way of writing this machine.
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === '::1' || host === 'localhost'
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
