import { Hono } from 'hono'
import {
  blobCheckRequest,
  createReviewRequest,
  snapshotManifest,
  type ReviewStatus,
} from '@reviewd/protocol'
import {
  createReview,
  createSnapshot,
  listReviews,
  missingBlobs,
  putBlob,
  readBlob,
  ReviewError,
  summarize,
  type Deps,
} from '../reviews.js'

/**
 * Review, snapshot, and blob routes.
 *
 * Every response that carries a link gets it from the service layer, which
 * builds one from public_url. Nothing here reads the address a request arrived
 * on, because that address is loopback for the agent and useless on a phone.
 */
export function reviewRoutes(deps: Deps): Hono {
  const routes = new Hono()

  routes.post('/api/reviews', async (c) => {
    const parsed = createReviewRequest.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json({ error: describe(parsed.error.issues) }, 400)
    }

    const summary = await createReview(deps, parsed.data)
    return c.json(summary, 201)
  })

  routes.get('/api/reviews', async (c) => {
    const status = c.req.query('status')
    const rootPath = c.req.query('root')

    const summaries = await listReviews(deps, {
      ...(status === 'open' || status === 'approved' ? { status: status as ReviewStatus } : {}),
      ...(rootPath ? { rootPath } : {}),
    })

    return c.json(summaries)
  })

  routes.get('/api/reviews/:id', async (c) => c.json(await summarize(deps, c.req.param('id'))))

  routes.post('/api/reviews/:id/blobs/check', async (c) => {
    const parsed = blobCheckRequest.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json({ error: describe(parsed.error.issues) }, 400)
    }

    return c.json({ missing: await missingBlobs(deps.db, parsed.data.ids) })
  })

  // Content-addressed, so the id is the whole address and the review it belongs
  // to does not enter into it.
  routes.put('/api/blobs/:id', async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const result = await putBlob(deps, c.req.param('id'), bytes)
    return c.json(result, result.stored ? 201 : 200)
  })

  routes.get('/api/blobs/:id', async (c) => {
    const blob = await readBlob(deps.db, c.req.param('id'))
    if (!blob) return c.json({ error: `no blob ${c.req.param('id')}` }, 404)

    // A Buffer is a Uint8Array over a possibly-shared ArrayBuffer, which Hono's
    // body type refuses. Copying into a plain view costs one allocation.
    return c.body(new Uint8Array(blob.bytes), 200, {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.size),
    })
  })

  routes.post('/api/reviews/:id/snapshots', async (c) => {
    const parsed = snapshotManifest.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json({ error: describe(parsed.error.issues) }, 400)
    }

    const result = await createSnapshot(deps, c.req.param('id'), parsed.data)
    return c.json(result, 201)
  })

  routes.onError((error, c) => {
    if (error instanceof ReviewError) {
      return c.json({ error: error.message }, error.status)
    }
    throw error
  })

  return routes
}

function describe(issues: { path: PropertyKey[]; message: string }[]): string {
  const first = issues[0]
  if (!first) return 'invalid request'
  const where = first.path.map(String).join('.')
  return where ? `${where}: ${first.message}` : first.message
}
