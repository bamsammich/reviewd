import { Hono } from 'hono'
import { z } from 'zod'
import {
  createThreadRequest,
  replyRequest,
  submitRequest,
  threadState,
  turn as turnSchema,
} from '../../protocol.js'
import { ReviewError, type Deps } from '../reviews.js'
import {
  createThread,
  listThreads,
  replyToThread,
  setThreadState,
  submitReview,
  type ThreadFilter,
} from '../threads.js'

/**
 * Local rather than in protocol.ts because nothing off this route speaks it.
 * The state itself is protocol and comes from there; the note is a line the
 * reviewer typed on the way past, and no other client needs a name for the
 * pair. It is a schema at all because a hand-written cast validates nothing —
 * it only tells the compiler to stop asking.
 */
const threadStateRequest = z.object({
  state: threadState,
  note: z.string().optional(),
})

/**
 * Thread, message, and submission routes.
 *
 * Drafts stay behind an explicit opt-in. The UI asks for them; nothing on an
 * agent-facing path does, which is what keeps the agent from acting on comments
 * the reviewer has not sent.
 */
export function threadRoutes(deps: Deps): Hono {
  const routes = new Hono()

  // Authorship comes from which door the message arrived through, never from
  // the message. This is the agent's door, so everything through it is the
  // agent's, and a body claiming otherwise cannot make the page render "you"
  // over words the reviewer never wrote.
  routes.post('/api/reviews/:id/threads', async (c) => {
    // A body that is not JSON is the schema's problem, not the parser's: left
    // to throw, `{oops` escapes to app.onError and comes back a 500 carrying a
    // parser message, when what the caller sent was simply an invalid request.
    const body: unknown = await c.req.json().catch(() => ({}))
    const parsed = createThreadRequest.safeParse(body)
    if (!parsed.success) return c.json({ error: describe(parsed.error.issues) }, 400)

    return c.json(
      await createThread(deps, c.req.param('id'), { ...parsed.data, author: 'agent' }),
      201,
    )
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
    const body: unknown = await c.req.json().catch(() => ({}))
    const parsed = replyRequest.safeParse(body)
    if (!parsed.success) return c.json({ error: describe(parsed.error.issues) }, 400)

    return c.json(await replyToThread(deps, c.req.param('id'), parsed.data.body, 'agent'))
  })

  routes.put('/api/threads/:id/state', async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}))
    const parsed = threadStateRequest.safeParse(body)
    if (!parsed.success) return c.json({ error: describe(parsed.error.issues) }, 400)

    return c.json(
      await setThreadState(deps, c.req.param('id'), parsed.data.state, parsed.data.note),
    )
  })

  // One submission sends every draft at once, so a wait fires once here rather
  // than once per comment.
  //
  // A verdict is the reviewer's, and this API is what the agent holds, so the
  // two verdicts that only report ("I wrote notes", "I want changes") are
  // allowed here and approval is not. Approving happens through the review page
  // and its token, which the agent has no copy of. Without this split the gate
  // is decorative: the process being gated could clear itself with one call.
  routes.post('/api/reviews/:id/submissions', async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}))
    const parsed = submitRequest.safeParse(body)
    if (!parsed.success) return c.json({ error: describe(parsed.error.issues) }, 400)

    if (parsed.data.verdict === 'approved') {
      return c.json(
        {
          error:
            'Approval comes from the review page, not from the API. Open the review and approve there.',
        },
        403,
      )
    }

    return c.json(await submitReview(deps, c.req.param('id'), parsed.data.verdict), 201)
  })

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
