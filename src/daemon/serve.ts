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

  // The report waits for the listen to succeed. Printed straight through, it
  // announced an address the daemon had not got yet, so a failed start led with
  // "reviewd listening on ..." and contradicted itself two lines later.
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    for (const line of startupReport(config)) {
      process.stdout.write(`${line}\n`)
    }
    process.stdout.write(`reviewd database ${config.databasePath}\n`)
  })

  const stopSweep = scheduleSweep({ db, config })

  // A listen failure arrives as an event, not a rejected promise, so the
  // `main().catch` in cli.ts never sees it and Node prints its own stack trace
  // instead. EADDRINUSE is the ordinary case rather than an exotic one: a
  // commit hook spawns the daemon on its own, so a person running `reviewd
  // serve` afterwards is usually looking at one that is already up.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      process.stderr.write(
        `reviewd: ${config.host}:${config.port} is already in use.\n` +
          `A reviewd is probably serving it already — run \`reviewd doctor\` to check,\n` +
          `or set port in ${config.configPath} to move this one.\n`,
      )
    } else {
      process.stderr.write(
        `reviewd: cannot listen on ${config.host}:${config.port}: ${error.message}\n`,
      )
    }
    process.exit(1)
  })

  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    void db.destroy().finally(() => process.exit(0))
  }

  let leaving = false
  const shutdown = (): void => {
    if (leaving) return
    leaving = true
    stopSweep()

    // The server closes before the database does, so a request already in
    // flight gets to finish and answer rather than having its connection cut
    // and its work rolled back underneath it. But a long-poll parks for up to
    // half an hour, and a shutdown that waits on one is a shutdown that never
    // happens, so the grace period is short and then we leave regardless.
    const abandon = setTimeout(finish, 2_000)
    abandon.unref()
    server.close(() => {
      clearTimeout(abandon)
      finish()
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
