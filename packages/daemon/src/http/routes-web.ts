import { Hono } from 'hono'
import { listReviews, ReviewError, summarize, type Deps } from '../reviews.js'
import { touchReview } from '../sweep.js'
import { loadFiles, messagePage, reviewListPage, reviewPage } from '../web/pages.js'

/**
 * The pages a reviewer opens.
 *
 * Reading a review counts as activity, so opening one keeps the sweep off it.
 * A review someone checks daily but never writes to is live work.
 */
export function webRoutes(deps: Deps): Hono {
  const routes = new Hono()

  routes.get('/', async (c) => {
    const reviews = await listReviews(deps, {})
    return c.html(reviewListPage(reviews).value)
  })

  routes.get('/r/:id', async (c) => {
    const reviewId = c.req.param('id')

    try {
      const review = await summarize(deps, reviewId)
      await touchReview(deps.db, reviewId)
      const files = await loadFiles(deps.db, reviewId)

      return c.html(reviewPage(review, files).value)
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

  return routes
}
