import { EMPTY_FINGERPRINT } from '../fingerprint.js'
import { WAIT_EXIT, type GateResponse } from '../protocol.js'
import { Client } from './client.js'
import { loadClientConfig } from './config.js'
import { fingerprint } from './diff.js'
import { ensureDaemon, logPath } from './ensure.js'
import { repoRoot, stagedDivergence } from './git.js'
import { runMcpServer } from './mcp.js'

/** One long-poll round. Shorter than the deadline so a proxy idle timeout cannot strand it. */
const MAX_POLL_MS = 300_000

/**
 * Serves the MCP tools an agent drives reviews with.
 *
 * An agent reaching for a review tool should not have to be told the service
 * behind it is not running, so this brings the daemon up first.
 */
export async function runMcp(): Promise<void> {
  await ensureDaemon(loadClientConfig().base_url)
  return await runMcpServer()
}

export async function printFingerprint(path: string, json: boolean): Promise<void> {
  const root = await requireRepo(path)
  if (!root) return

  const value = await fingerprint(root)
  process.stdout.write(json ? `${JSON.stringify({ root, fingerprint: value })}\n` : `${value}\n`)
}

/**
 * Answers the commit hook.
 *
 * The reason and the review URL go to stdout so the hook can hand them
 * straight to the agent, and the exit code carries the verdict so a shell
 * script needs no parsing.
 */
export async function checkGate(path: string, json: boolean): Promise<void> {
  const root = await requireRepo(path)
  if (!root) return

  // Asked before the daemon, because the daemon cannot see it. An approval
  // covers the working tree; a commit writes the index. Where those two hold
  // different content, no approval means anything about what is about to land,
  // so this is a refusal rather than a question.
  const diverged = await stagedDivergence(root)
  if (diverged.length > 0) {
    const result: GateResponse = {
      decision: 'deny',
      reason:
        `${diverged.length} file${diverged.length === 1 ? ' has' : 's have'} staged content ` +
        `that differs from the working tree, so committing would carry code the review never ` +
        `showed:\n  ${diverged.slice(0, 10).join('\n  ')}\n\n` +
        `Stage the rest with \`git add -A\`, or unstage with \`git reset\`, then commit again.`,
      reviewUrl: null,
      warnings: [],
      openThreads: [],
    }

    return report(result, json)
  }

  const value = await fingerprint(root)

  // Nothing to review means nothing to gate: an --amend that only edits a
  // message leaves the tree identical to HEAD. This lived in the hook, which
  // meant it returned before the check above ever ran, and a tree made to look
  // empty while the index held a change was the cheapest way past the gate.
  if (value === EMPTY_FINGERPRINT) {
    return report(
      {
        decision: 'allow',
        reason: `${root} has no changes against HEAD, so there is nothing to review.`,
        reviewUrl: null,
        warnings: [],
        openThreads: [],
      },
      json,
    )
  }

  const baseUrl = loadClientConfig().base_url
  await ensureDaemon(baseUrl)

  const client = new Client(baseUrl)
  return report(await client.gate(root, value), json)
}

/** One shape for the hook to read, whoever decided. */
function report(result: GateResponse, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else {
    process.stdout.write(`${result.reason}\n`)
    if (result.reviewUrl) process.stdout.write(`${result.reviewUrl}\n`)
    for (const warning of result.warnings) process.stdout.write(`warning: ${warning}\n`)
  }

  process.exitCode = result.decision === 'allow' ? 0 : 1
}

/**
 * Checks the daemon answers where its links point.
 *
 * A wrong public_url kills every link the agent hands over while nothing else
 * looks broken, so it gets a command rather than a comment in a config file.
 */
export async function doctor(): Promise<void> {
  const config = loadClientConfig()
  const result = await ensureDaemon(config.base_url)

  if (result.running) {
    const how = result.started ? ', started just now' : ''
    process.stdout.write(`reviewd: answering at ${config.base_url}${how}\n`)
    if (result.started) process.stdout.write(`reviewd: logging to ${logPath()}\n`)
    return
  }

  process.stderr.write(
    `reviewd: nothing answers at ${config.base_url}, and starting one failed.\n` +
      `  ${result.error ?? 'no reason given'}\n\n` +
      `Check that reviewd is on PATH, read ${logPath()},\n` +
      `or set base_url in ~/.config/reviewd/client.json.\n`,
  )
  process.exitCode = 1
}

/**
 * Blocks until the reviewer submits, then exits.
 *
 * Designed to run as a background command: the harness resumes the session when
 * the process exits, so the wait costs nothing while it runs and fires the
 * moment a submission lands. The exit code carries the verdict, so the agent
 * knows what happened before reading a byte of output.
 */
export async function waitForSubmission(
  reviewId: string | undefined,
  timeoutSeconds: number,
): Promise<void> {
  if (!reviewId) {
    process.stderr.write('reviewd: wait needs --review <id>\n')
    process.exitCode = WAIT_EXIT.failed
    return
  }

  const waitUrl = loadClientConfig().base_url
  await ensureDaemon(waitUrl)

  const client = new Client(waitUrl)
  const deadline = Date.now() + timeoutSeconds * 1000
  const since = Date.now()

  while (Date.now() < deadline) {
    const remaining = Math.min(deadline - Date.now(), MAX_POLL_MS)
    const result = await client.wait(reviewId, remaining, since)

    // Every verdict exits 0. The answer is the first line of stdout, which is
    // where a caller reads it from regardless; an exit code that said
    // "changes requested" was indistinguishable from a command that crashed.
    if (result.wokeOn === 'released') {
      process.stdout.write('released\n')
      process.exitCode = WAIT_EXIT.answered
      return
    }

    if (result.wokeOn === 'submission') {
      process.stdout.write(`${result.verdict ?? 'submitted'}\n`)
      if (result.url) process.stdout.write(`${result.url}\n`)
      process.exitCode = WAIT_EXIT.answered
      return
    }
  }

  process.stdout.write('timeout\n')
  process.exitCode = WAIT_EXIT.timeout
}

async function requireRepo(path: string): Promise<string | null> {
  const root = await repoRoot(path)
  if (root) return root

  process.stderr.write(`reviewd: ${path} is not inside a git repository\n`)
  process.exitCode = 1
  return null
}
