import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * Client configuration.
 *
 * One key, because the daemon holds no credentials: reachability is the access
 * boundary, so all a client needs is where to reach it.
 */

export const clientConfigSchema = z.object({
  base_url: z.string().url().default('http://127.0.0.1:7777'),
})

export type ClientConfig = z.infer<typeof clientConfigSchema>

export function defaultClientConfigPath(): string {
  const base = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config')
  return join(base, 'reviewd', 'client.json')
}

export function loadClientConfig(path = defaultClientConfigPath()): ClientConfig {
  let raw: unknown = {}

  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A missing file is the normal case: loopback is the default and needs no
    // configuration at all.
    if (code !== 'ENOENT') {
      throw new Error(`reviewctl: cannot read ${path}: ${String(error)}`)
    }
  }

  const parsed = clientConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new Error(
      `reviewctl: ${path} is invalid at ${first?.path.join('.') ?? 'config'}: ${first?.message ?? ''}`,
    )
  }

  return {
    base_url: (process.env['REVIEWD_URL'] || parsed.data.base_url).replace(/\/$/, ''),
  }
}
