import { Hono, type Context } from 'hono'
import { verdict as verdictSchema } from '@reviewd/protocol'
import { listReviews, ReviewError, summarize, type Deps } from '../reviews.js'
import { touchReview } from '../sweep.js'
import { createThread, listThreads, replyToThread, setThreadState, submitReview, unapprove } from '../threads.js'
import { loadFiles, messagePage, reviewListPage } from '../web/pages.js'
import { parseOpenBox, parseViewMode, reviewPage } from '../web/review-page.js'

/**
 * The pages a reviewer opens and the forms they act through.
 *
 * Every mutation is a form POST that redirects back, so the pages work with
 * nothing enabled and a reload never resubmits. The script that ships only
 * saves a round trip when opening a comment box.
 */
export function webRoutes(deps: Deps): Hono {
  const routes = new Hono()

  routes.get('/', async (c) => c.html(reviewListPage(await listReviews(deps, {})).value))

  routes.get('/r/:id', async (c) => {
    const reviewId = c.req.param('id')

    try {
      const review = await summarize(deps, reviewId)
      // Reading a review is activity, so opening one keeps the sweep off it.
      await touchReview(deps.db, reviewId)

      const [files, threads] = await Promise.all([
        loadFiles(deps.db, reviewId),
        listThreads(deps, reviewId, { includeDrafts: true }),
      ])

      // The preference lives in a cookie so a reload keeps it and the URL
      // stays shareable without carrying one person's display choice.
      const asked = c.req.query('view')
      if (asked === 'split' || asked === 'unified') {
        setCookie(c, 'reviewd_view', asked)
        return c.redirect(`/r/${reviewId}`, 303)
      }

      const view = parseViewMode(cookie(c, 'reviewd_view'))

      return c.html(
        reviewPage(review, files, threads, parseOpenBox(c.req.query('box')), view).value,
      )
    } catch (error) {
      if (error instanceof ReviewError && error.status === 404) {
        return c.html(
          messagePage(
            'Not found',
            'That review is gone. An agent released it, or it was swept after sitting idle.',
          ).value,
          404,
        )
      }
      throw error
    }
  })

  routes.post('/r/:id/threads', async (c) => {
    const reviewId = c.req.param('id')
    const form = await c.req.parseBody()

    const line = Number(form['line'])
    const side = form['side'] === 'old' ? 'old' : 'new'
    const body = String(form['body'] ?? '').trim()

    if (!body || !Number.isInteger(line)) return back(c, reviewId)

    await createThread(deps, reviewId, {
      sourceId: String(form['sourceId'] ?? ''),
      path: String(form['path'] ?? ''),
      line,
      side,
      body,
      author: 'human',
    })

    return back(c, reviewId)
  })

  routes.post('/r/:id/threads/:threadId/replies', async (c) => {
    const body = String((await c.req.parseBody())['body'] ?? '').trim()
    if (body) await replyToThread(deps, c.req.param('threadId'), body, 'human')

    return back(c, c.req.param('id'), c.req.param('threadId'))
  })

  routes.post('/r/:id/threads/:threadId/resolve', async (c) => {
    await setThreadState(deps, c.req.param('threadId'), 'resolved')
    return back(c, c.req.param('id'), c.req.param('threadId'))
  })

  routes.post('/r/:id/threads/:threadId/reopen', async (c) => {
    await setThreadState(deps, c.req.param('threadId'), 'active')
    return back(c, c.req.param('id'), c.req.param('threadId'))
  })

  // One submission sends every draft at once, which is what makes a waiting
  // agent wake when the reviewer is finished rather than mid-sentence.
  routes.post('/r/:id/submit', async (c) => {
    const parsed = verdictSchema.safeParse((await c.req.parseBody())['verdict'])
    if (parsed.success) await submitReview(deps, c.req.param('id'), parsed.data)

    return back(c, c.req.param('id'))
  })

  routes.post('/r/:id/unapprove', async (c) => {
    await unapprove(deps, c.req.param('id'))
    return back(c, c.req.param('id'))
  })

  routes.onError((error, c) => {
    if (error instanceof ReviewError) {
      return c.html(messagePage('Cannot do that', error.message).value, error.status)
    }
    throw error
  })

  return routes
}

function cookie(c: Context, name: string): string | undefined {
  const header = c.req.header('cookie')
  if (!header) return undefined

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }

  return undefined
}

function setCookie(c: Context, name: string, value: string): void {
  c.header(
    'set-cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`,
  )
}

/** A redirect after every mutation, so a reload never resubmits the form. */
function back(c: Context, reviewId: string, threadId?: string): Response {
  const fragment = threadId ? `#t-${threadId}` : ''
  return c.redirect(`/r/${reviewId}${fragment}`, 303)
}
