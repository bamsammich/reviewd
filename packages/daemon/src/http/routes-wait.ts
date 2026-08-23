import { Hono } from 'hono'
import type { WaitResult } from '@reviewd/protocol'
import type { Bus } from '../bus.js'
import { countThreadsByTurn, reviewUrl, type Deps } from '../reviews.js'

const MAX_TIMEOUT_MS = 1_800_000
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * The long-poll that `reviewctl wait` blocks on.
 *
 * A caller passes the last submission time it knows about. Anything newer is
 * answered immediately, so a submission that lands between two waits is never
 * missed; only then does the request park on the bus.
 */
export function waitRoutes(deps: Deps & { bus: Bus }): Hono {
  const routes = new Hono()

  routes.get('/api/reviews/:id/wait', async (c) => {
    const reviewId = c.req.param('id')
    const since = Number(c.req.query('since') ?? 0)
    const timeout = Math.min(
      Number(c.req.query('timeout_ms') ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )

    const missed = await submissionAfter(deps, reviewId, since)
    if (missed) return c.json(missed)

    const exists = await deps.db
      .selectFrom('review')
      .select('id')
      .where('id', '=', reviewId)
      .executeTakeFirst()

    if (!exists) return c.json(gone(), 200)

    const event = await deps.bus.wait(reviewId, timeout, c.req.raw.signal)

    if (!event) {
      return c.json<WaitResult>({
        wokeOn: 'timeout',
        verdict: null,
        threadsAwaitingAgent: (await countThreadsByTurn(deps.db, reviewId)).agent,
        url: reviewUrl(deps.config, reviewId),
      })
    }

    if (event.kind === 'released') return c.json(gone())

    return c.json<WaitResult>({
      wokeOn: 'submission',
      verdict: event.verdict,
      threadsAwaitingAgent: (await countThreadsByTurn(deps.db, reviewId)).agent,
      url: reviewUrl(deps.config, reviewId),
    })
  })

  return routes
}

/**
 * Answers a submission the caller has not seen yet.
 *
 * Without this a submission landing in the gap between two waits would sit
 * unnoticed until the next one, which on a review that gets one submission is
 * forever.
 */
async function submissionAfter(
  deps: Deps,
  reviewId: string,
  since: number,
): Promise<WaitResult | undefined> {
  const submission = await deps.db
    .selectFrom('submission')
    .selectAll()
    .where('review_id', '=', reviewId)
    .where('submitted_at', '>', since)
    .orderBy('submitted_at', 'desc')
    .executeTakeFirst()

  if (!submission) return undefined

  return {
    wokeOn: 'submission',
    verdict: submission.verdict,
    threadsAwaitingAgent: (await countThreadsByTurn(deps.db, reviewId)).agent,
    url: reviewUrl(deps.config, reviewId),
  }
}

function gone(): WaitResult {
  return { wokeOn: 'released', verdict: null, threadsAwaitingAgent: 0, url: null }
}
