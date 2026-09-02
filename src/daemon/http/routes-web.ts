import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { verdict as verdictSchema } from '../../protocol.js'
import type { Bus } from '../bus.js'
import { listReviews, ReviewError, summarize, type Deps } from '../reviews.js'
import { touchReview } from '../sweep.js'
import {
  createThread,
  deleteDraft,
  editDraft,
  listThreads,
  replyToThread,
  setThreadState,
  submitReview,
  unapprove,
} from '../threads.js'
import { loadCommits, loadFiles, messagePage, reviewListPage } from '../web/pages.js'
import {
  parseFolds,
  parseOpenBox,
  parseRail,
  parseViewMode,
  reviewPage,
} from '../web/review-page.js'
import { readPageToken } from '../web/tokens.js'

/** Long enough to stay quiet, short enough that a dead tab is noticed. */
const HEARTBEAT_MS = 25_000

/**
 * The pages a reviewer opens and the forms they act through.
 *
 * Every mutation is a form POST that redirects back, so the pages work with
 * nothing enabled and a reload never resubmits. The script that ships only
 * saves a round trip when opening a comment box.
 */
export function webRoutes(deps: Deps & { bus: Bus }): Hono {
  const routes = new Hono()

  const fontScale = deps.config.ui.font_scale

  routes.get('/', async (c) => c.html(reviewListPage(await listReviews(deps, {}), fontScale).value))

  routes.get('/r/:id', async (c) => {
    const reviewId = c.req.param('id')

    try {
      const review = await summarize(deps, reviewId)
      // Reading a review is activity, so opening one keeps the sweep off it.
      await touchReview(deps.db, reviewId)

      // Which commit is being read travels in the URL rather than a cookie.
      // The cookies below carry display preferences, which belong to one
      // person and should not ride along on a shared link. The commit is what
      // the page is about, so a link to it has to carry it.
      const commits = await loadCommits(deps.db, reviewId)
      const askedCommit = c.req.query('commit')
      const commit =
        askedCommit === undefined ? undefined : commits.find((one) => one.sha === askedCommit)

      const [files, threads] = await Promise.all([
        loadFiles(deps.db, reviewId, commit?.id),
        listThreads(deps, reviewId, { includeDrafts: true }),
      ])

      // The preferences live in cookies so a reload keeps them and the URL
      // stays shareable without carrying one person's display choice.
      //
      // Both are read before redirecting. Each used to redirect on its own,
      // which was fine while every link carried one of them and silently wrong
      // the moment a link carried both: the first won, the second was dropped,
      // and a control that named the state it was preserving did not preserve
      // it.
      const askedView = c.req.query('view')
      const askedRail = c.req.query('rail')
      let asked = false

      if (askedView === 'split' || askedView === 'unified') {
        setCookie(c, 'reviewd_view', askedView)
        asked = true
      }

      if (askedRail === 'open' || askedRail === 'closed') {
        setCookie(c, 'reviewd_rail', askedRail)
        asked = true
      }

      // The commit rides through the redirect, because it says what the page
      // is showing rather than how. Changing to unified while reading commit
      // three should leave you on commit three.
      if (asked) {
        const back = commit === undefined ? '' : `?commit=${encodeURIComponent(commit.sha)}`
        return c.redirect(`/r/${reviewId}${back}`, 303)
      }

      const view = parseViewMode(cookie(c, 'reviewd_view'))
      const rail = parseRail(cookie(c, 'reviewd_rail'))
      // Folds are written by the page itself, so this cookie is the only place
      // that knows what the reviewer already decided was fine.
      const folded = parseFolds(cookie(c, 'reviewd_folds'), reviewId)

      return c.html(
        reviewPage(
          review,
          files,
          threads,
          parseOpenBox(c.req.query('box'), c.req.query('to')),
          view,
          folded,
          rail,
          {
            commits,
            ...(commit === undefined ? {} : { selected: commit }),
            // The reader's own toggle, written by the page when they open or
            // close the list.
            listOpen: cookie(c, 'reviewd_commits') === 'open',
          },
          fontScale,
        ).value,
      )
    } catch (error) {
      if (error instanceof ReviewError && error.status === 404) {
        return c.html(
          messagePage(
            'Not found',
            'That review is gone. An agent released it, or it was swept after sitting idle.',
            fontScale,
          ).value,
          404,
        )
      }
      throw error
    }
  })

  /**
   * Tells an open review page when the agent has written something.
   *
   * The page holds this open and refetches itself when it fires, so a reply
   * lands without the reviewer knowing to reload. EventSource reconnects on
   * its own and replays Last-Event-ID, which is what covers a daemon restart
   * and the gap either side of it: anything the agent wrote while the stream
   * was down is answered on connect rather than waiting for the next write.
   *
   * Submissions reach here too. The reasoning for leaving them out was that a
   * submission is the reviewer's own action on the page that already
   * re-rendered from it, which is true of the browser they pressed the button
   * in and false of every other one. A review open on a laptop and a phone
   * showed the laptop's notes on the phone only once an agent happened to
   * write something, which is a refresh arriving for an unrelated reason.
   */
  routes.get('/r/:id/events', async (c) => {
    const reviewId = c.req.param('id')
    const since = Number(c.req.header('last-event-id') ?? c.req.query('since') ?? 0) || 0
    const signal = c.req.raw.signal

    return streamSSE(c, async (stream) => {
      const missed = await wroteAfter(deps, reviewId, since)
      if (missed) await stream.writeSSE({ event: 'threads', id: String(missed), data: '' })

      while (!signal.aborted) {
        const event = await deps.bus.wait(reviewId, HEARTBEAT_MS, signal)

        if (signal.aborted) break

        if (!event) {
          // A comment frame, not an event: it keeps the socket warm and lets
          // the write fail once the reviewer has closed the tab.
          await stream.writeSSE({ data: '', event: 'ping' })
          continue
        }

        if (event.kind === 'released') {
          await stream.writeSSE({ event: 'gone', data: '' })
          break
        }

        // Both carry the same instruction: what the page is showing is behind,
        // go and fetch it. A submission sends every draft on the review at
        // once, so one frame here covers however many comments it carried.
        if (event.kind === 'thread' || event.kind === 'submission') {
          await stream.writeSSE({ event: 'threads', id: String(event.at), data: '' })
        }

        // A new revision replaces what the page is showing, so the page has to
        // hear about it or the reviewer goes on reading code that is gone and
        // holding a token that describes it.
        if (event.kind === 'snapshot') {
          await stream.writeSSE({
            event: 'revision',
            id: String(event.at),
            data: String(event.seq),
          })
        }
      }
    })
  })

  routes.post('/r/:id/threads', async (c) => {
    const reviewId = c.req.param('id')
    const form = await c.req.parseBody()

    requireToken(reviewId, form['token'])

    const side = form['side'] === 'old' ? 'old' : 'new'
    const body = String(form['body'] ?? '').trim()
    if (!body) return back(c, reviewId)

    // The overall-comment form posts a body and nothing else, which is what
    // makes it a comment about the review rather than about a line.
    const path = String(form['path'] ?? '')
    const line = Number(form['line'])
    const anchored = path.length > 0 && Number.isInteger(line)

    if (path.length > 0 !== Number.isInteger(line)) return back(c, reviewId)

    const end = Number(form['endLine'])
    const endLine = anchored && Number.isInteger(end) && end > line ? end : undefined

    // Which reading of the file the reviewer had on screen. A comment written
    // while reading one commit is about the line as that commit left it.
    const commitSha = String(form['commitSha'] ?? '')

    const created = await createThread(deps, reviewId, {
      side,
      body,
      author: 'human',
      ...(anchored ? { sourceId: String(form['sourceId'] ?? ''), path, line } : {}),
      ...(endLine === undefined ? {} : { endLine }),
      ...(anchored && commitSha.length > 0 ? { commitSha } : {}),
    })

    // Back to the comment just written, on the view it was written on. Without
    // the id this redirected to the top of the review, so writing a note two
    // thousand lines down cost the reviewer their place every time.
    return back(c, reviewId, created.threadId, commitSha)
  })

  routes.post('/r/:id/threads/:threadId/replies', async (c) => {
    const form = await c.req.parseBody()
    requireToken(c.req.param('id'), form['token'])
    await requireThreadIn(c.req.param('id'), c.req.param('threadId'))

    const body = String(form['body'] ?? '').trim()
    if (body) await replyToThread(deps, c.req.param('threadId'), body, 'human')

    return back(c, c.req.param('id'), c.req.param('threadId'))
  })

  routes.post('/r/:id/threads/:threadId/resolve', async (c) => {
    requireToken(c.req.param('id'), (await c.req.parseBody())['token'])
    await requireThreadIn(c.req.param('id'), c.req.param('threadId'))
    await setThreadState(deps, c.req.param('threadId'), 'resolved')
    return back(c, c.req.param('id'), c.req.param('threadId'))
  })

  routes.post('/r/:id/threads/:threadId/reopen', async (c) => {
    requireToken(c.req.param('id'), (await c.req.parseBody())['token'])
    await requireThreadIn(c.req.param('id'), c.req.param('threadId'))
    await setThreadState(deps, c.req.param('threadId'), 'active')
    return back(c, c.req.param('id'), c.req.param('threadId'))
  })

  // Editing and deleting reach a message rather than a thread, because what
  // can still change is one comment and not the conversation around it.
  routes.post('/r/:id/messages/:messageId', async (c) => {
    const form = await c.req.parseBody()
    requireToken(c.req.param('id'), form['token'])
    const threadId = await requireMessageIn(c.req.param('id'), c.req.param('messageId'))

    const body = String(form['body'] ?? '').trim()
    if (body) await editDraft(deps, c.req.param('messageId'), body)

    return back(c, c.req.param('id'), threadId)
  })

  routes.post('/r/:id/messages/:messageId/delete', async (c) => {
    requireToken(c.req.param('id'), (await c.req.parseBody())['token'])
    await requireMessageIn(c.req.param('id'), c.req.param('messageId'))
    await deleteDraft(deps, c.req.param('messageId'))

    // Back to the review rather than to the thread: deleting the last comment
    // takes the thread with it, and a fragment pointing at something gone
    // leaves the reader at the top of the page wondering what happened.
    return back(c, c.req.param('id'))
  })

  // One submission sends every draft at once, which is what makes a waiting
  // agent wake when the reviewer is finished rather than mid-sentence.
  routes.post('/r/:id/submit', async (c) => {
    const reviewId = c.req.param('id')
    const form = await c.req.parseBody()

    await requireCurrentToken(deps, reviewId, form['token'])

    const parsed = verdictSchema.safeParse(form['verdict'])
    if (parsed.success) await submitReview(deps, reviewId, parsed.data)

    return back(c, reviewId)
  })

  routes.post('/r/:id/unapprove', async (c) => {
    const reviewId = c.req.param('id')

    await requireCurrentToken(deps, reviewId, (await c.req.parseBody())['token'])
    await unapprove(deps, reviewId)

    return back(c, reviewId)
  })

  /**
   * A verdict is only a verdict if it came from the page.
   *
   * The token is minted into the submit form and nowhere else, so a POST that
   * arrives without one was written by something that never rendered the
   * review. That is the agent, and approving its own work is the one thing it
   * must not be able to do.
   *
   * Binding to the current revision means a token from a page showing older
   * code cannot approve what replaced it, which is the rule the approval
   * already follows.
   */
  /**
   * Every mutating form proves it came from a page the daemon drew.
   *
   * This is what the cross-site check used to be for, done in a way that does
   * not depend on the browser volunteering a usable `Origin`. An in-app webview
   * sends `Origin: null`, which is a page with an opaque origin rather than a
   * hostile one, and treating the two the same locked a reviewer out of their
   * own review.
   */
  function requireToken(reviewId: string, token: unknown): { snapshotSeq: number } {
    const read = readPageToken(typeof token === 'string' ? token : undefined, reviewId, Date.now())

    if (!read) {
      throw new ReviewError(
        'That request did not come from this review page, or the page has been open long ' +
          'enough for its session to lapse. Reload the review and try again.',
        403,
      )
    }

    return read
  }

  /**
   * A page token only reaches the threads of its own review.
   *
   * The thread routes take an id straight out of the path, so checking the
   * token against `:id` alone left any token good for every thread in every
   * other review: a reply posted that way was written through the page door and
   * therefore recorded as the reviewer, in a review whose holder never opened
   * it. Authorship follows the route, which only means something if the route
   * is about the review it names.
   */
  /** The thread a message belongs to, once this review is known to own it. */
  async function requireMessageIn(reviewId: string, messageId: string): Promise<string> {
    const found = await deps.db
      .selectFrom('message')
      .innerJoin('thread', 'thread.id', 'message.thread_id')
      .select(['thread.id as thread_id', 'thread.review_id'])
      .where('message.id', '=', messageId)
      .executeTakeFirst()

    if (found?.review_id !== reviewId) {
      throw new ReviewError('That comment is not part of this review.', 403)
    }

    return found.thread_id
  }

  async function requireThreadIn(reviewId: string, threadId: string): Promise<void> {
    const thread = await deps.db
      .selectFrom('thread')
      .select('review_id')
      .where('id', '=', threadId)
      .executeTakeFirst()

    if (thread?.review_id !== reviewId) {
      throw new ReviewError('That comment is not part of this review.', 403)
    }
  }

  /**
   * A verdict additionally has to be about the revision on screen.
   *
   * Comments survive a new snapshot, because the reviewer was mid-sentence and
   * their words should not be lost to the agent pushing again. An approval must
   * not: it would clear code the reviewer never saw.
   */
  async function requireCurrentToken(deps_: Deps, reviewId: string, token: unknown): Promise<void> {
    const { snapshotSeq } = requireToken(reviewId, token)
    const review = await summarize(deps_, reviewId)

    if (snapshotSeq !== review.snapshotSeq) {
      throw new ReviewError(
        `This page is showing revision ${snapshotSeq} and the review is now at ` +
          `${review.snapshotSeq}. Reload it and decide on what is there now.`,
        403,
      )
    }
  }

  routes.onError((error, c) => {
    if (error instanceof ReviewError) {
      return c.html(messagePage('Cannot do that', error.message, fontScale).value, error.status)
    }
    throw error
  })

  return routes
}

/**
 * When the agent last wrote to this review, if it was after `since`.
 *
 * Submitted state only: a reviewer's own draft is not activity anyone needs
 * pushed back at them, and the agent never drafts.
 */
async function wroteAfter(
  deps: Deps,
  reviewId: string,
  since: number,
): Promise<number | undefined> {
  const agent = await deps.db
    .selectFrom('message')
    .innerJoin('thread', 'thread.id', 'message.thread_id')
    .select('message.created_at as at')
    .where('thread.review_id', '=', reviewId)
    .where('message.author', '=', 'agent')
    .where('message.created_at', '>', since)
    .orderBy('message.created_at', 'desc')
    .executeTakeFirst()

  // A submission the reviewer made in another browser counts the same. This
  // used to ask about agent messages alone, so a page reconnecting across a
  // sleep or a daemon restart came back still missing the notes its own
  // reviewer had sent from a different device.
  const submission = await deps.db
    .selectFrom('submission')
    .select('submitted_at as at')
    .where('review_id', '=', reviewId)
    .where('submitted_at', '>', since)
    .orderBy('submitted_at', 'desc')
    .executeTakeFirst()

  const times = [agent?.at, submission?.at].filter((at) => at !== undefined)
  return times.length > 0 ? Math.max(...times) : undefined
}

function cookie(c: Context, name: string): string | undefined {
  const header = c.req.header('cookie')
  if (!header) return undefined

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key !== name) continue

    try {
      return decodeURIComponent(rest.join('='))
    } catch {
      // Anything else on localhost can set a cookie scoped to localhost, and a
      // value that is not valid percent-encoding threw out of the page render
      // as a 500 that named no cause. A display preference is not worth that.
      return undefined
    }
  }

  return undefined
}

/**
 * Appended rather than set, because a response can carry more than one cookie.
 *
 * `c.header` replaces by default, so writing two cookies wrote one: the second
 * silently took the first one's place. Nothing noticed while each control sent
 * a single preference.
 */
function setCookie(c: Context, name: string, value: string): void {
  c.header(
    'set-cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`,
    { append: true },
  )
}

/** A redirect after every mutation, so a reload never resubmits the form. */
function back(c: Context, reviewId: string, threadId?: string, commitSha?: string): Response {
  const fragment = threadId ? `#t-${threadId}` : ''
  const query = commitSha ? `?commit=${encodeURIComponent(commitSha)}` : ''
  return c.redirect(`/r/${reviewId}${query}${fragment}`, 303)
}
