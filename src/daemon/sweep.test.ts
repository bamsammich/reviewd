import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configSchema, resolve, type ResolvedConfig } from './config.js'
import { tempDatabase, type TempDatabase } from './db/testing.js'
import { notify, render } from './notify.js'
import { createReview, putBlob, sha256, type Deps } from './reviews.js'
import { runSweep, touchReview } from './sweep.js'

let ctx: TempDatabase
let deps: Deps

const DAY_MS = 86_400_000

beforeEach(async () => {
  ctx = await tempDatabase()
  const config = resolve(configSchema.parse({}), {
    configPath: '/tmp/reviewd-test.json',
    bindPublic: false,
  })
  deps = { db: ctx.db, config }
})

afterEach(async () => {
  await ctx.close()
})

async function reviewIdleFor(days: number, title = 'old review'): Promise<string> {
  const review = await createReview(deps, {
    title,
    sources: [{ path: `/tmp/${title.replaceAll(' ', '-')}`, base: 'HEAD', includeUntracked: true }],
    createdBy: '',
    notify: false,
  })

  await ctx.db
    .updateTable('review')
    .set({ last_activity_at: Date.now() - days * DAY_MS })
    .where('id', '=', review.reviewId)
    .execute()

  return review.reviewId
}

describe('sweep', () => {
  it('leaves a review inside the horizon alone', async () => {
    await reviewIdleFor(13)

    const result = await runSweep(deps)

    expect(result.reviews).toBe(0)
    expect(await ctx.db.selectFrom('review').selectAll().execute()).toHaveLength(1)
  })

  it('removes a review past it and names what went', async () => {
    await reviewIdleFor(20, 'abandoned')

    const result = await runSweep(deps)

    expect(result.reviews).toBe(1)
    expect(result.removed[0]?.title).toBe('abandoned')
    expect(result.removed[0]?.idleDays).toBeGreaterThanOrEqual(20)
  })

  it('keys on activity rather than on age', async () => {
    // A review created long ago but looked at yesterday is live work.
    const reviewId = await reviewIdleFor(30, 'long running')
    await touchReview(ctx.db, reviewId)

    expect((await runSweep(deps)).reviews).toBe(0)
  })

  it('honors a configured horizon', async () => {
    await reviewIdleFor(5)
    const config: ResolvedConfig = {
      ...deps.config,
      sweep: { review_idle_days: 3 },
    }

    expect((await runSweep({ ...deps, config })).reviews).toBe(1)
  })

  it('collects the bytes a swept review leaves behind', async () => {
    await reviewIdleFor(20)
    const content = new TextEncoder().encode('orphaned by the sweep')
    await putBlob(deps, sha256(content), content)

    const result = await runSweep(deps)

    expect(result.blobs).toBe(1)
    expect(await ctx.db.selectFrom('blob').selectAll().execute()).toHaveLength(0)
  })
})

describe('notify', () => {
  const payload = { title: 'two roots', url: 'https://mac.ts.net/r/abc', threadsAwaitingYou: 3 }

  it('stays quiet when no webhook is configured', async () => {
    const fetcher = vi.fn()
    expect(await notify(deps.config, payload, fetcher)).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('posts JSON when no template is set', async () => {
    const config = withWebhook(null)
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))

    expect(await notify(config, payload, fetcher)).toBe(true)

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      title: 'two roots',
      url: 'https://mac.ts.net/r/abc',
      threads_awaiting_you: 3,
    })
  })

  it('renders a template as plain text, which is what a push bridge wants', () => {
    const rendered = render('{{title}} needs you: {{url}} ({{threads}} threads)', payload)

    expect(rendered.body).toBe('two roots needs you: https://mac.ts.net/r/abc (3 threads)')
    expect(rendered.contentType).toBe('text/plain')
  })

  it('swallows a webhook that refuses', async () => {
    // A push that does not arrive should never fail the snapshot behind it.
    const config = withWebhook(null)
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const log = vi.fn()

    expect(await notify(config, payload, fetcher, log)).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('500'))
  })

  it('swallows a webhook that is unreachable', async () => {
    const config = withWebhook(null)
    const fetcher = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const log = vi.fn()

    expect(await notify(config, payload, fetcher, log)).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'))
  })

  function withWebhook(template: string | null): ResolvedConfig {
    return {
      ...deps.config,
      notify: { webhook_url: 'https://ntfy.sh/reviewd-test', template },
    }
  }
})
