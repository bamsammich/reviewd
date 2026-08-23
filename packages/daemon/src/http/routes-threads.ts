import { Hono } from 'hono'
import {
  createThreadRequest,
  replyRequest,
  submitRequest,
  threadState,
  turn as turnSchema,
} from '@reviewd/protocol'
import { ReviewError, type Deps } from '../reviews.js'
import {
  createThread,
  listThreads,
  replyToThread,
  setThreadState,
  submitReview,
  unapprove,
  type ThreadFilter,
} from '../threads.js'

/**
 * Thread, message, and submission routes.
 *
 * Drafts stay behind an explicit opt-in. The UI asks for them; nothing on an
 * agent-facing path does, which is what keeps the agent from acting on comments
 * the reviewer has not sent.
 */
export function threadRoutes(deps: Deps): Hono {
  const routes = new Hono()

  routes.post('/api/reviews/:id/threads', async (c) => {
    const parsed = createThreadRequest.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: describe(parsed.error.issues) }, 400)

    return c.json(await createThread(deps, c.req.param('id'), parsed.data), 201)
  })

  routes.get('/api/reviews/:id/threads', async (c) => {
    const state = threadState.safeParse(c.req.query('state'))
    const turn = turnSchema.safeParse(c.req.query('turn'))

    const filter: ThreadFilter = {
      ...(state.success ? { state: state.data } : {}),
      ...(turn.success ? { turn: turn.data } : {}),
      includeDrafts: c.req.query('drafts') === 'true',
    }

    return c.json(await listThreads(deps, c.req.param('id'), filter))
  })

  routes.post('/api/threads/:id/replies', async (c) => {
    const parsed = replyRequest.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: describe(parsed.error.issues) }, 400)

    return c.json(
      await replyToThread(deps, c.req.param('id'), parsed.data.body, parsed.data.author),
    )
  })

  routes.put('/api/threads/:id/state', async (c) => {
    const body = (await c.req.json()) as { state?: unknown; note?: unknown }
    const parsed = threadState.safeParse(body.state)
    if (!parsed.success)
      return c.json({ error: 'state must be active, resolved, or outdated' }, 400)

    const note = typeof body.note === 'string' ? body.note : undefined
    return c.json(await setThreadState(deps, c.req.param('id'), parsed.data, note))
  })

  // One submission sends every draft at once, so a wait fires once here rather
  // than once per comment.
  routes.post('/api/reviews/:id/submissions', async (c) => {
    const parsed = submitRequest.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: describe(parsed.error.issues) }, 400)

    return c.json(await submitReview(deps, c.req.param('id'), parsed.data.verdict), 201)
  })

  routes.delete('/api/reviews/:id/approval', async (c) =>
    c.json(await unapprove(deps, c.req.param('id'))),
  )

  routes.onError((error, c) => {
    if (error instanceof ReviewError) return c.json({ error: error.message }, error.status)
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
