import { Hono } from 'hono'
import { gateRequest, releaseRequest } from '../../protocol.js'
import { gate, release } from '../gate.js'
import { ReviewError, type Deps } from '../reviews.js'

/**
 * The commit gate and release.
 *
 * The gate reads as a question and was a GET for that reason, but answering it
 * stamps consumed_at, and a GET that writes is reachable from an `<img>` tag.
 * The stamp is worth keeping — it is how release tells a used approval from an
 * abandoned one — so the method moves instead.
 */
export function gateRoutes(deps: Deps): Hono {
  const routes = new Hono()

  routes.post('/api/gate', async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}))
    const parsed = gateRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'root and fingerprint are both required' }, 400)
    }

    return c.json(await gate(deps, parsed.data))
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
