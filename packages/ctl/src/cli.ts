#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { WAIT_EXIT } from '@reviewd/protocol'
import { Client } from './client.js'
import { loadClientConfig } from './config.js'
import { fingerprint, repoRoot } from './git.js'
import { runMcpServer } from './mcp.js'

/** One long-poll round. Shorter than the deadline so a proxy idle timeout cannot strand it. */
const MAX_POLL_MS = 300_000

const USAGE = `reviewctl - client for the reviewd review daemon

Usage: reviewctl <command> [options]

Commands:
  mcp                       Serve the MCP tools an agent drives reviews with
  wait --review <id>        Block until the reviewer submits, then exit
  fingerprint [path]        Hash every change against HEAD, tracked or not
  gate [path]               Ask whether a commit in this repository is approved
  doctor                    Check that the daemon answers where links point

Options:
  --json                    Machine-readable output
  -h, --help                Show this message

Exit codes for gate: 0 allowed, 1 denied.
Exit codes for wait: 0 approved, 2 changes requested, 3 released, 124 timeout.
`

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      review: { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  })

  const [command, target] = positionals

  if (values.help || !command) {
    process.stdout.write(USAGE)
    return
  }

  switch (command) {
    case 'mcp':
      return await runMcpServer()
    case 'wait':
      return await waitForSubmission(values.review, Number(values.timeout ?? 3600))
    case 'fingerprint':
      return await printFingerprint(target ?? process.cwd(), values.json ?? false)
    case 'gate':
      return await checkGate(target ?? process.cwd(), values.json ?? false)
    case 'doctor':
      return await doctor()
    default:
      process.stderr.write(`reviewctl: unknown command "${command}"\n\n${USAGE}`)
      process.exitCode = 1
  }
}

async function printFingerprint(path: string, json: boolean): Promise<void> {
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
async function checkGate(path: string, json: boolean): Promise<void> {
  const root = await requireRepo(path)
  if (!root) return

  const client = new Client(loadClientConfig().base_url)
  const result = await client.gate(root, await fingerprint(root))

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
async function doctor(): Promise<void> {
  const config = loadClientConfig()
  const client = new Client(config.base_url)

  if (await client.health()) {
    process.stdout.write(`reviewctl: reviewd answers at ${config.base_url}\n`)
    return
  }

  process.stderr.write(
    `reviewctl: nothing answers at ${config.base_url}.\n` +
      `Start reviewd, or set base_url in ~/.config/reviewd/client.json.\n`,
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
async function waitForSubmission(
  reviewId: string | undefined,
  timeoutSeconds: number,
): Promise<void> {
  if (!reviewId) {
    process.stderr.write('reviewctl: wait needs --review <id>\n')
    process.exitCode = 1
    return
  }

  const client = new Client(loadClientConfig().base_url)
  const deadline = Date.now() + timeoutSeconds * 1000
  const since = Date.now()

  while (Date.now() < deadline) {
    const remaining = Math.min(deadline - Date.now(), MAX_POLL_MS)
    const result = await client.wait(reviewId, remaining, since)

    if (result.wokeOn === 'released') {
      process.stdout.write('review released\n')
      process.exitCode = WAIT_EXIT.gone
      return
    }

    if (result.wokeOn === 'submission') {
      process.stdout.write(`${result.verdict ?? 'submitted'}\n`)
      if (result.url) process.stdout.write(`${result.url}\n`)
      process.exitCode =
        result.verdict === 'approved' ? WAIT_EXIT.approved : WAIT_EXIT.changesRequested
      return
    }
  }

  process.stdout.write('timeout\n')
  process.exitCode = WAIT_EXIT.timeout
}

async function requireRepo(path: string): Promise<string | null> {
  const root = await repoRoot(path)
  if (root) return root

  process.stderr.write(`reviewctl: ${path} is not inside a git repository\n`)
  process.exitCode = 1
  return null
}

main().catch((error: unknown) => {
  process.stderr.write(`reviewctl: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
