import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configSchema, resolve } from '../daemon/config.js'
import { tempDatabase, type TempDatabase } from '../daemon/db/testing.js'
import { createApp } from '../daemon/http/app.js'
import { Client } from './client.js'
import { createMcpServer } from './mcp.js'
import { tempRepo, type TempRepo } from './testing.js'

/**
 * The MCP surface driven the way an agent drives it, over a real transport,
 * against a real daemon holding a real git repository.
 */

let ctx: TempDatabase
let repo: TempRepo
let mcp: McpClient

beforeEach(async () => {
  ctx = await tempDatabase()
  const config = resolve(configSchema.parse({ public_url: 'https://mac.tailnet-name.ts.net' }), {
    configPath: '/tmp/reviewd-mcp.json',
    bindPublic: false,
  })
  const app = createApp({ config, db: ctx.db, local: true })

  const http = new Client('http://127.0.0.1:7777', (input, init) =>
    app.request(String(input).replace('http://127.0.0.1:7777', ''), {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), host: '127.0.0.1:7777' },
    }),
  )

  repo = tempRepo()
  repo.write('src/app.ts', 'const a = 1\nconst b = 2\nconst c = 3\n')
  repo.commit('initial')
  repo.write('src/app.ts', 'const a = 1\nconst b = 99\nconst c = 3\n')

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await createMcpServer(http).connect(serverTransport)

  mcp = new McpClient({ name: 'test-agent', version: '0' })
  await mcp.connect(clientTransport)
})

afterEach(async () => {
  repo.cleanup()
  await mcp.close()
  await ctx.close()
})

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await mcp.callTool({ name, arguments: args })) as {
    content: { text: string }[]
    isError?: boolean
  }

  const text = result.content[0]?.text ?? ''
  if (result.isError) throw new Error(text)

  return JSON.parse(text) as Record<string, unknown>
}

describe('the tool surface', () => {
  it('exposes exactly the tools the spec names', async () => {
    const { tools } = await mcp.listTools()

    expect(tools.map((t) => t.name).sort()).toEqual([
      'review_create',
      'review_get',
      'review_list',
      'review_release',
      'review_snapshot',
      'thread_create',
      'thread_reply',
      'thread_resolve',
      'threads_list',
    ])
  })

  it('opens a review and returns a link built from public_url', async () => {
    const created = await call('review_create', {
      title: 'bump b',
      sources: [{ path: repo.root, base: 'HEAD' }],
    })

    // Never the loopback address the agent reached the daemon on.
    expect(created['url']).toMatch(/^https:\/\/mac\.tailnet-name\.ts\.net\/r\//)
    expect(created['fileCount']).toBe(1)
  })

  it('keeps diff content out of every result', async () => {
    const created = await call('review_create', {
      title: 'bump b',
      sources: [{ path: repo.root, base: 'HEAD' }],
    })

    const get = await call('review_get', { reviewId: created['reviewId'] })
    const threads = await call('threads_list', { reviewId: created['reviewId'] })

    // A 4000-line diff must never land in a tool result, so no payload here
    // carries a file body.
    for (const result of [created, get, threads]) {
      expect(JSON.stringify(result)).not.toContain('const b = 99')
    }
  })

  it('lets the agent open a thread on its own output', async () => {
    const created = await call('review_create', {
      title: 'bump b',
      sources: [{ path: repo.root, base: 'HEAD' }],
    })

    const thread = await call('thread_create', {
      reviewId: created['reviewId'],
      path: 'src/app.ts',
      line: 2,
      body: 'I picked 99 from the ticket, worth a check',
    })

    expect(thread['threadId']).toEqual(expect.any(String))

    const threads = (await call('threads_list', {
      reviewId: created['reviewId'],
    })) as unknown as { turn: string; messages: { author: string }[] }[]

    expect(threads).toHaveLength(1)
    // The agent asked, so the reviewer owes the answer.
    expect(threads[0]?.turn).toBe('human')
    expect(threads[0]?.messages[0]?.author).toBe('agent')
  })

  it('pushes a revision after editing', async () => {
    const created = await call('review_create', {
      title: 'bump b',
      sources: [{ path: repo.root, base: 'HEAD' }],
    })

    repo.write('src/app.ts', 'const a = 1\nconst b = 100\nconst c = 3\n')
    const snapshot = await call('review_snapshot', { reviewId: created['reviewId'] })

    expect(snapshot['seq']).toBe(2)
  })

  it('narrows a list to reviews covering one directory', async () => {
    await call('review_create', {
      title: 'bump b',
      sources: [{ path: repo.root, base: 'HEAD' }],
    })

    const here = (await call('review_list', { root: repo.root })) as unknown as unknown[]
    const elsewhere = (await call('review_list', { root: '/tmp/nothing' })) as unknown as unknown[]

    expect(here).toHaveLength(1)
    expect(elsewhere).toHaveLength(0)
  })

  it('refuses to release while an approval has not been used', async () => {
    const created = await call('review_create', {
      title: 'bump b',
      sources: [{ path: repo.root, base: 'HEAD' }],
    })

    await ctx.db
      .insertInto('submission')
      .values({
        id: 'sub-1',
        review_id: created['reviewId'] as string,
        verdict: 'approved',
        message_count: 0,
        submitted_at: Date.now(),
      })
      .execute()

    const snapshot = await ctx.db.selectFrom('snapshot').selectAll().executeTakeFirstOrThrow()
    const source = await ctx.db.selectFrom('source').selectAll().executeTakeFirstOrThrow()
    await ctx.db
      .insertInto('approval')
      .values({
        id: 'app-1',
        review_id: created['reviewId'] as string,
        snapshot_id: snapshot.id,
        source_id: source.id,
        root_path: source.root_path,
        fingerprint: 'whatever',
        approved_at: Date.now(),
        consumed_at: null,
      })
      .execute()

    const result = await call('review_release', { reviewId: created['reviewId'] })

    expect(result['released']).toBe(false)
    expect(result['reason']).toMatch(/no commit has used that approval/)
  })

  it('reports a failure as a tool error rather than a crash', async () => {
    await expect(call('review_get', { reviewId: 'does-not-exist' })).rejects.toThrow(/no review/)
  })
})
