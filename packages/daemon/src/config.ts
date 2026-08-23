import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/**
 * Configuration lives at $XDG_CONFIG_HOME/reviewd/config.json and holds no
 * credentials, because reachability is the access boundary. Every key here
 * either decides what the daemon binds to or bounds what it will store.
 */

const MB = 1024 * 1024

export const configSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(7777),
  /**
   * The base for every link the daemon emits. The daemon knows what it bound
   * to and cannot know what address a phone should open, so a tunnel has to
   * say. Null falls back to http://host:port.
   */
  public_url: z.string().url().nullable().default(null),
  database: z.object({ path: z.string().default('') }).default({ path: '' }),
  limits: z
    .object({
      max_blob_bytes: z
        .number()
        .int()
        .positive()
        .default(2 * MB),
      max_files_per_snapshot: z.number().int().positive().default(2000),
    })
    .default({ max_blob_bytes: 2 * MB, max_files_per_snapshot: 2000 }),
  sweep: z
    .object({ review_idle_days: z.number().int().positive().default(14) })
    .default({ review_idle_days: 14 }),
  notify: z
    .object({
      webhook_url: z.string().url().nullable().default(null),
      template: z.string().nullable().default(null),
    })
    .default({ webhook_url: null, template: null }),
})

export type Config = z.infer<typeof configSchema>

/** Config plus everything derived from it, so nothing recomputes a base URL. */
export interface ResolvedConfig extends Config {
  configPath: string
  databasePath: string
  /** Never null. Falls back to the bind address when public_url is unset. */
  publicUrl: string
  /** Hostnames the daemon will answer to. Anything else is a rebinding attempt. */
  allowedHosts: Set<string>
  bindsPublicly: boolean
}

function xdg(envVar: string, fallback: string): string {
  const value = process.env[envVar]
  return value && value.length > 0 ? value : join(homedir(), fallback)
}

export function defaultConfigPath(): string {
  return join(xdg('XDG_CONFIG_HOME', '.config'), 'reviewd', 'config.json')
}

export function defaultDatabasePath(): string {
  return join(xdg('XDG_STATE_HOME', '.local/state'), 'reviewd', 'reviews.db')
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost', '0:0:0:0:0:0:0:1'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(stripPort(host).toLowerCase())
}

/** Strips a trailing :port, leaving IPv6 literals intact whether bracketed or bare. */
export function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    return close === -1 ? host : host.slice(0, close + 1)
  }

  // A bare IPv6 literal is all colons and no brackets, so there is no port to
  // strip and the last colon belongs to the address.
  const firstColon = host.indexOf(':')
  if (firstColon !== -1 && host.indexOf(':', firstColon + 1) !== -1) {
    return host
  }

  return firstColon === -1 ? host : host.slice(0, firstColon)
}

/** Addresses that name an interface rather than somewhere a client can reach. */
function isUnroutableForClients(hostname: string): boolean {
  const name = stripPort(hostname).toLowerCase()
  return isLoopbackHost(name) || name === '0.0.0.0' || name === '::' || name === '[::]'
}

/**
 * Reads the config file, creating it with defaults the first time.
 *
 * A malformed file is an error rather than a silent fallback: a typo in
 * public_url would otherwise send every link to an address nothing answers on,
 * with nothing else looking broken.
 */
export function loadConfig(
  options: { configPath?: string; bindPublic?: boolean } = {},
): ResolvedConfig {
  const configPath = options.configPath ?? defaultConfigPath()

  let raw: unknown = {}
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw new Error(`reviewd: cannot read ${configPath}: ${String(error)}`)
    }
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify({}, null, 2)}\n`, { mode: 0o600 })
  }

  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first ? first.path.join('.') : 'config'
    const why = first ? first.message : 'invalid'
    throw new Error(`reviewd: ${configPath} is invalid at ${where}: ${why}`)
  }

  return resolve(parsed.data, { configPath, bindPublic: options.bindPublic ?? false })
}

export function resolve(
  config: Config,
  options: { configPath: string; bindPublic: boolean },
): ResolvedConfig {
  const databasePath = config.database.path || defaultDatabasePath()
  const publicUrl = (config.public_url ?? `http://${config.host}:${config.port}`).replace(/\/$/, '')

  const allowedHosts = new Set<string>(LOOPBACK_HOSTS)
  try {
    allowedHosts.add(new URL(publicUrl).hostname.toLowerCase())
  } catch {
    throw new Error(`reviewd: public_url is not a URL: ${publicUrl}`)
  }
  // Binding to a named interface means requests arrive addressed to that name.
  allowedHosts.add(config.host.toLowerCase())

  return {
    ...config,
    configPath: options.configPath,
    databasePath,
    publicUrl,
    allowedHosts,
    bindsPublicly: !isLoopbackHost(config.host),
  }
}

/**
 * Refuses a non-loopback bind that nobody asked for on the command line.
 *
 * A configuration key alone is too quiet for this: it can be copied between
 * machines, or edited months earlier, and the result is a review server
 * answering the whole network without anyone deciding so that day.
 */
export function assertBindAllowed(config: ResolvedConfig, bindPublic: boolean): void {
  if (isLoopbackHost(config.host)) return
  if (bindPublic) return

  throw new Error(
    `reviewd: host is ${config.host}, which is reachable beyond this machine.\n` +
      `Pass --bind-public to allow it, or set host to 127.0.0.1 in ${config.configPath}.`,
  )
}

/** Lines printed at startup so a wrong public_url is visible immediately. */
export function startupReport(config: ResolvedConfig): string[] {
  const lines = [
    `reviewd listening on http://${config.host}:${config.port}`,
    `reviewd links point at ${config.publicUrl}`,
  ]

  // The fallback base is the bind address, which names an interface rather
  // than a place a phone can reach. Left alone on a public bind, every link the
  // agent hands over is dead and nothing else looks wrong.
  if (config.bindsPublicly && isUnroutableForClients(new URL(config.publicUrl).hostname)) {
    lines.push(
      `reviewd warning: public_url resolves to ${new URL(config.publicUrl).hostname}, which no`,
      '  other device can open, so every link it hands out will be dead.',
      `  Set public_url in ${config.configPath} to the address a phone should use.`,
    )
  }

  if (config.bindsPublicly) {
    lines.push(
      'reviewd warning: anything that can route to this port can read and comment on reviews.',
    )
  }

  return lines
}
