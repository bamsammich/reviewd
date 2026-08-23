import { Hono } from 'hono'
import type { Kysely } from 'kysely'
import { capabilities as capabilitiesSchema } from '@reviewd/protocol'
import type { ResolvedConfig } from '../config.js'
import type { Database } from '../db/types.js'
import { hardening } from './hardening.js'

export interface AppContext {
  config: ResolvedConfig
  db: Kysely<Database>
  /** True when the daemon shares a filesystem with the reviewed code. */
  local: boolean
}

export type App = Hono

/**
 * Builds the HTTP app without binding a port, so tests drive the real
 * middleware stack through `app.request()` rather than a mock.
 */
export function createApp(ctx: AppContext): App {
  const app = new Hono()

  for (const middleware of hardening(ctx.config)) {
    app.use('*', middleware)
  }

  app.get('/api/health', (c) => c.json({ ok: true }))

  app.get('/api/capabilities', (c) =>
    c.json(
      capabilitiesSchema.parse({
        version: '0.0.0',
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
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ error: message }, 500)
  })

  return app
}
