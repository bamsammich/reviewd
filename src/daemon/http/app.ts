import { createRequire } from 'node:module'
import { Hono } from 'hono'
import type { Kysely } from 'kysely'
import { capabilities as capabilitiesSchema } from '../../protocol.js'
import { Bus } from '../bus.js'
import type { ResolvedConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { ReviewError } from '../reviews.js'
import { hardening } from './hardening.js'
import { reviewRoutes } from './routes-reviews.js'
import { gateRoutes } from './routes-gate.js'
import { threadRoutes } from './routes-threads.js'
import { waitRoutes } from './routes-wait.js'
import { webRoutes } from './routes-web.js'

export interface AppContext {
  config: ResolvedConfig
  db: Kysely<Database>
  /** True when the daemon shares a filesystem with the reviewed code. */
  local: boolean
  bus?: Bus
}

export type App = Hono

// Read rather than hardcoded, because a version string maintained by hand is a
// version string that is wrong. A client negotiating against this number needs
// it to mean the daemon it is actually talking to.
const version =
  (createRequire(import.meta.url)('../../../package.json') as { version?: string }).version ??
  'unknown'

/**
 * Builds the HTTP app without binding a port, so tests drive the real
 * middleware stack through `app.request()` rather than a mock.
 */
export function createApp(ctx: AppContext): App {
  const app = new Hono()

  for (const middleware of hardening(ctx.config)) {
    app.use('*', middleware)
  }

  const bus = ctx.bus ?? new Bus()
  const deps = { db: ctx.db, config: ctx.config, bus }
  app.route('/', reviewRoutes(deps))
  app.route('/', threadRoutes(deps))
  app.route('/', gateRoutes(deps))
  app.route('/', waitRoutes(deps))
  app.route('/', webRoutes(deps))

  app.get('/api/health', (c) => c.json({ ok: true }))

  app.get('/api/capabilities', (c) =>
    c.json(
      capabilitiesSchema.parse({
        version,
        local: ctx.local,
        // Reaching a file to open it, or watching one for changes, only works
        // where the daemon and the code share a disk.
        openInEditor: ctx.local,
        fileWatch: ctx.local,
      }),
    ),
  )

  app.notFound((c) => c.json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404))

  app.onError((error, c) => {
    // A ReviewError is written for the person reading the page, so it still
    // travels. Every sub-router catches its own; this is the backstop for the
    // ones raised outside them.
    if (error instanceof ReviewError) {
      return c.json({ error: error.message }, error.status)
    }

    // Anything else is the daemon's business and stays there. A SQLite
    // constraint or a filesystem error names tables and absolute paths, and on
    // a public bind the requester is the network.
    //
    // It goes to stderr because that is where the log points (see ensure.ts,
    // which hands the spawned daemon the log file for both streams). Silently
    // returning a 500 leaves whoever is chasing a reviewer's broken page with
    // an empty log and nothing to read.
    process.stderr.write(
      `reviewd: ${c.req.method} ${c.req.path} failed: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    )

    return c.json({ error: 'the daemon failed while handling this request' }, 500)
  })

  return app
}
