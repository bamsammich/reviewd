import { serve } from '@hono/node-server'
import { assertBindAllowed, loadConfig, startupReport } from './config.js'
import { openDatabase } from './db/index.js'
import { createApp } from './http/app.js'
import { scheduleSweep } from './sweep.js'

export interface ServeOptions {
  configPath?: string | undefined
  bindPublic?: boolean | undefined
}

/**
 * Runs the daemon everything else talks to.
 *
 * Whatever can reach the port can read and comment on reviews. The default
 * bind is loopback; bindPublic is required to widen that, and the startup
 * report names what became reachable.
 */
export async function runServe(options: ServeOptions = {}): Promise<void> {
  const bindPublic = options.bindPublic ?? false
  const config = loadConfig({
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    bindPublic,
  })

  assertBindAllowed(config, bindPublic)

  const db = await openDatabase({ path: config.databasePath })
  const app = createApp({ config, db, local: true })

  serve({ fetch: app.fetch, hostname: config.host, port: config.port })
  const stopSweep = scheduleSweep({ db, config })

  for (const line of startupReport(config)) {
    process.stdout.write(`${line}\n`)
  }
  process.stdout.write(`reviewd database ${config.databasePath}\n`)

  const shutdown = (): void => {
    stopSweep()
    void db.destroy().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
