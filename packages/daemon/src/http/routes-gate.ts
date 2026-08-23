import { Hono } from 'hono'
import { releaseRequest } from '@reviewd/protocol'
import { gate, release } from '../gate.js'
import { ReviewError, type Deps } from '../reviews.js'

/**
 * The commit gate and release.
 *
 * The gate is a GET because the hook calls it before every commit and it
 * answers a question. Stamping consumed_at is bookkeeping about that question
 * having been asked rather than a change to what the answer is, so a retry
 * gets the same verdict.
 */
export function gateRoutes(deps: Deps): Hono {
  const routes = new Hono()

  routes.get('/api/gate', async (c) => {
    const root = c.req.query('root')
    const fingerprint = c.req.query('fingerprint')

    if (!root || !fingerprint) {
      return c.json({ error: 'root and fingerprint are both required' }, 400)
    }

    return c.json(await gate(deps, { root, fingerprint }))
  })

  routes.post('/api/reviews/:id/release', async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}))
    const parsed = releaseRequest.safeParse(body)
    const force = parsed.success ? parsed.data.force : false

    const result = await release(deps, c.req.param('id'), force)
    return c.json(result, result.released ? 200 : 409)
  })

  routes.onError((error, c) => {
    if (error instanceof ReviewError) return c.json({ error: error.message }, error.status)
    throw error
  })

  return routes
}
