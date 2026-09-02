import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { Client } from './client.js'
import { loadClientConfig } from './config.js'
import { DEFAULT_LIMITS } from './diff.js'
import { canonical } from './git.js'
import { pushSnapshot } from './push.js'

/**
 * The MCP surface an agent drives reviews through.
 *
 * Three rules shape every tool here. No diff content crosses the model context,
 * so results carry counts and ids rather than file bodies. Results stay small
 * enough to call in a loop. And every mutating tool returns a URL the daemon
 * built from public_url, because the agent must never assemble one: it reaches
 * the daemon on loopback, and a loopback link is dead on the phone the reviewer
 * is holding.
 */

interface ToolResult {
  // The SDK's result type carries an open index signature for extensions.
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * A tool's arguments, with anything it does not name refused.
 *
 * The default is to drop an unknown key and answer as though the call was
 * fine, which is the worst of both: an agent that misremembers a parameter
 * gets a success and a result missing whatever it asked for. Every summary
 * written into `review_create` before it took one was discarded this way, and
 * nothing said so, on either side.
 *
 * Strict turns that into a message the agent can read and fix on its next
 * call, which is the only version of this that ends.
 */
function strict<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict()
}

export function createMcpServer(client = new Client(loadClientConfig().base_url)): McpServer {
  // Read rather than hardcoded, because a version string maintained by hand is
  // a version string that is wrong. Every MCP client is told this at handshake.
  const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string }
  const server = new McpServer({ name: 'reviewd', version: pkg.version ?? 'unknown' })

  server.registerTool(
    'review_create',
    {
      title: 'Open a review',
      description:
        'Opens a review over one or more directories and pushes the current changes. ' +
        'Returns a URL to hand the reviewer. Several roots in one review is ordinary: ' +
        'pass every directory the change touches.',
      inputSchema: strict({
        title: z.string().describe('What this change does, in a few words'),
        summary: z
          .string()
          .optional()
          .describe(
            'What the reviewer should know before reading: what changed, what to argue with, ' +
              'what you decided and why. Opens a comment on the change as a whole.',
          ),
        sources: z
          .array(
            z.object({
              path: z.string().describe('Absolute path to a repository or directory'),
              base: z
                .string()
                .optional()
                .describe(
                  'Ref to compare against. Omit and a git repository is compared against HEAD, ' +
                    'while any other directory is read as a file set',
                ),
              label: z.string().optional(),
            }),
          )
          .min(1),
        notify: z.boolean().optional().describe('Send the configured push notification'),
      }),
    },
    async ({ title, summary, sources, notify }) => {
      try {
        const review = await client.createReview({
          title,
          sources: sources.map((s) => ({
            // Canonical, so the path stored here is the one the commit hook
            // will compute when it asks the gate about this repository.
            path: canonical(s.path),
            ...(s.base === undefined ? {} : { base: s.base }),
            ...(s.label === undefined ? {} : { label: s.label }),
          })),
          createdBy: 'agent',
          notify: notify ?? false,
        })

        const snapshot = await pushSnapshot(
          client,
          review.reviewId,
          review.sources.map((s) => ({
            id: s.id,
            rootPath: s.rootPath,
            baseRef: s.baseRef ?? undefined,
          })),
          DEFAULT_LIMITS,
        )

        // After the snapshot, so the note lands on a review that has something
        // to read. A thread with no path is the review-level comment the page
        // draws above the diff.
        if (summary !== undefined && summary.trim().length > 0) {
          // No path, which is what makes it a comment about the change as a
          // whole. `side` is required by the wire shape and means nothing
          // without a line.
          await client.createThread(review.reviewId, {
            body: summary,
            author: 'agent',
            side: 'new',
          })
        }

        return ok({
          reviewId: review.reviewId,
          url: review.url,
          fileCount: snapshot.fileCount,
          sources: review.sources.map((s) => ({ id: s.id, label: s.label, root: s.rootPath })),
        })
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'review_snapshot',
    {
      title: 'Push a new revision',
      description:
        'Recomputes every root and pushes a new revision after editing. Comments re-anchor ' +
        'to the code they were written against.',
      inputSchema: strict({ reviewId: z.string() }),
    },
    async ({ reviewId }) => {
      try {
        const review = await client.getReview(reviewId)
        const result = await pushSnapshot(
          client,
          reviewId,
          review.sources.map((s) => ({
            id: s.id,
            rootPath: s.rootPath,
            baseRef: s.baseRef ?? undefined,
          })),
          DEFAULT_LIMITS,
        )

        return ok(result)
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'review_get',
    {
      title: 'Check a review',
      description:
        'Status, current revision, per-source approval, and thread counts by whose turn it is. ' +
        'The one call that works with no live process, so a resumed session asks this first.',
      inputSchema: strict({ reviewId: z.string() }),
    },
    async ({ reviewId }) => {
      try {
        const review = await client.getReview(reviewId)
        return ok({
          reviewId: review.reviewId,
          title: review.title,
          status: review.status,
          url: review.url,
          revision: review.snapshotSeq,
          fileCount: review.fileCount,
          threadsAwaitingAgent: review.threadsAwaitingAgent,
          threadsAwaitingHuman: review.threadsAwaitingHuman,
          sources: review.sources.map((s) => ({
            id: s.id,
            label: s.label,
            root: s.rootPath,
            approved: s.approved,
          })),
        })
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'review_list',
    {
      title: 'List reviews',
      description: 'Open reviews, optionally narrowed to those covering one directory.',
      inputSchema: strict({
        status: z.enum(['open', 'approved']).optional(),
        root: z.string().optional().describe('Only reviews covering this directory'),
      }),
    },
    async ({ status, root }) => {
      try {
        const reviews = await client.listReviews({
          ...(status === undefined ? {} : { status }),
          ...(root === undefined ? {} : { root: canonical(root) }),
        })

        return ok(
          reviews.map((review) => ({
            reviewId: review.reviewId,
            title: review.title,
            status: review.status,
            url: review.url,
            ageSeconds: review.ageSeconds,
            threadsAwaitingAgent: review.threadsAwaitingAgent,
          })),
        )
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'threads_list',
    {
      title: 'Read comment threads',
      description:
        'Submitted messages only. Unsent drafts stay invisible, so nothing here is a comment ' +
        'the reviewer has not sent yet. Filter by turn "agent" for the only question worth ' +
        'asking: what is owed.',
      inputSchema: strict({
        reviewId: z.string(),
        state: z.enum(['active', 'resolved', 'outdated']).optional(),
        turn: z.enum(['human', 'agent']).optional(),
      }),
    },
    async ({ reviewId, state, turn }) => {
      try {
        const threads = await client.listThreads(reviewId, {
          ...(state === undefined ? {} : { state }),
          ...(turn === undefined ? {} : { turn }),
        })

        return ok(
          threads.map((thread) => ({
            threadId: thread.id,
            source: thread.sourceLabel,
            path: thread.path,
            line: thread.line,
            state: thread.state,
            turn: thread.turn,
            drifted: thread.drifted,
            messages: thread.messages.map((m) => ({ author: m.author, body: m.body })),
          })),
        )
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'thread_create',
    {
      title: 'Ask about your own change',
      description:
        'Opens a thread on a line of your own output, anchored where it applies. Use it for a ' +
        'judgment call worth flagging rather than burying the question in chat. Omit path and ' +
        'line together to ask about the change as a whole rather than about one line.',
      inputSchema: strict({
        reviewId: z.string(),
        path: z
          .string()
          .optional()
          .describe('Path relative to the source root. Omit, with line, to ask about the review'),
        line: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('First line the comment covers. Omit, with path, to ask about the review'),
        endLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Last line, for a comment about a block rather than a line'),
        body: z.string(),
        sourceId: z.string().optional().describe('Required when two roots share this path'),
        side: z.enum(['old', 'new']).optional(),
      }),
    },
    async ({ reviewId, path, line, endLine, body, sourceId, side }) => {
      try {
        const result = await client.createThread(reviewId, {
          path,
          line,
          body,
          author: 'agent',
          side: side ?? 'new',
          ...(endLine === undefined ? {} : { endLine }),
          ...(sourceId === undefined ? {} : { sourceId }),
        })

        return ok(result)
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'thread_reply',
    {
      title: 'Reply in a thread',
      description: 'Answers the reviewer. Your messages send immediately rather than drafting.',
      inputSchema: strict({ threadId: z.string(), body: z.string() }),
    },
    async ({ threadId, body }) => {
      try {
        return ok(await client.reply(threadId, body))
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'thread_resolve',
    {
      title: 'Close a thread',
      description:
        'Closes a thread you addressed. The reviewer sees it was closed by an agent and can ' +
        'reopen it in one click.',
      inputSchema: strict({ threadId: z.string(), note: z.string().optional() }),
    },
    async ({ threadId, note }) => {
      try {
        return ok(await client.setThreadState(threadId, 'resolved', note))
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'review_release',
    {
      title: 'Acknowledge and discard a review',
      description:
        'Says you saw the outcome, committed, and need none of the data. Refuses while an ' +
        'approval has not been used by a commit, since releasing first would delete the very ' +
        'approval that clears it. Pass force to abandon a review on purpose.',
      inputSchema: strict({ reviewId: z.string(), force: z.boolean().optional() }),
    },
    async ({ reviewId, force }) => {
      try {
        return ok(await client.release(reviewId, force ?? false))
      } catch (error) {
        return fail(error)
      }
    },
  )

  return server
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer()
  await server.connect(new StdioServerTransport())
}
