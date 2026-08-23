#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { serve } from '@hono/node-server'
import { assertBindAllowed, loadConfig, startupReport } from './config.js'
import { openDatabase } from './db/index.js'
import { createApp } from './http/app.js'
import { scheduleSweep } from './sweep.js'

const USAGE = `reviewd - local-first code review daemon

Usage: reviewd [options]

Options:
  --config <path>   Config file (default: $XDG_CONFIG_HOME/reviewd/config.json)
  --bind-public     Allow binding an address reachable beyond this machine
  -h, --help        Show this message
  -v, --version     Show the version

Whatever can reach the port can read and comment on reviews. The default bind
is loopback; --bind-public is required to widen that, and the startup report
names what became reachable.
`

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      'bind-public': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: false,
  })

  if (values.help) {
    process.stdout.write(USAGE)
    return
  }

  if (values.version) {
    process.stdout.write('0.0.0\n')
    return
  }

  const bindPublic = values['bind-public'] ?? false
  const config = loadConfig({
    ...(values.config === undefined ? {} : { configPath: values.config }),
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

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
