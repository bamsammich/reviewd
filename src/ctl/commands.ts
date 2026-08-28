import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { EMPTY_FINGERPRINT, manifestFingerprint } from '../fingerprint.js'
import { WAIT_EXIT, type GateResponse } from '../protocol.js'
import { Client } from './client.js'
import { loadClientConfig } from './config.js'
import { diffSource } from './diff.js'
import { ensureDaemon, logPath } from './ensure.js'
import { git, repoRoot, stagedDivergence } from './git.js'
import { initPlugin, installedPluginVersion, noClaudeMessage, planInit } from './init.js'
import { renderPlan, renderResult } from './init-report.js'
import { runMcpServer } from './mcp.js'

/** One long-poll round. Shorter than the deadline so a proxy idle timeout cannot strand it. */
const MAX_POLL_MS = 300_000

/** This binary's version, which is also the version of the plugin it installs. */
function version(): string {
  const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string }
  return pkg.version ?? 'unknown'
}

/**
 * Serves the MCP tools an agent drives reviews with.
 *
 * An agent reaching for a review tool should not have to be told the service
 * behind it is not running, so this brings the daemon up first.
 */
export async function runMcp(): Promise<void> {
  await ensureDaemon(loadClientConfig().base_url)
  await catchUpPlugin()
  return await runMcpServer()
}

/**
 * Reinstalls the plugin when it is a different version than this binary.
 *
 * `npm install -g reviewd@latest` replaces the binary and leaves the plugin
 * cache holding whatever it held before, so an upgrade would otherwise need a
 * second command nobody was told about. This is where that second command gets
 * run: the MCP server starts in every session the plugin loads, which makes it
 * the one piece of reviewd guaranteed to run under the version being replaced.
 *
 * The new copy is picked up next session rather than this one. Claude Code
 * reads its plugins at startup, so there is nothing to gain by hurrying, and
 * failure is not worth interrupting a session over: a plugin one version behind
 * still works, and doctor reports the drift.
 */
async function catchUpPlugin(): Promise<void> {
  if (process.env['REVIEWD_NO_PLUGIN_SYNC']) return

  try {
    const installed = await installedPluginVersion()
    if (!installed || installed === version()) return

    // A marketplace pointing somewhere other than where init would install
    // from is a deliberate local setup, and repointing it is how an automatic
    // sync deletes work nobody asked it to touch. Explicit `reviewd init`
    // still repoints, because a person typed it.
    const plan = await planInit()
    if (plan.marketplace.action === 'repoint') {
      process.stderr.write(
        `reviewd: plugin is ${installed}, this binary is ${version()}, and the ` +
          `${plan.marketplace.name} marketplace points at ${plan.marketplace.current}. ` +
          'Left alone. Run `reviewd init` to repoint it.\n',
      )
      return
    }

    await initPlugin()
    process.stderr.write(
      `reviewd: plugin was ${installed}, this binary is ${version()}. ` +
        'Reinstalled; it takes effect next session.\n',
    )
  } catch {
    // Reported by doctor rather than here. Nothing in a session depends on it.
  }
}

/**
 * Says whether Claude Code holds the plugin, and whether it matches.
 *
 * Drift is the failure this catches. The binary and the plugin are installed by
 * different tools, so a plugin one version behind is silent until a hook does
 * something the binary no longer expects.
 */
async function reportPlugin(): Promise<void> {
  const installed = await installedPluginVersion()

  if (!installed) {
    process.stdout.write(
      'reviewd: Claude Code does not have the plugin. Run `reviewd init` to add it.\n',
    )
    return
  }

  if (installed !== version()) {
    process.stdout.write(
      `reviewd: plugin is ${installed}, this binary is ${version()}. ` +
        'Run `reviewd init` to line them up.\n',
    )
    return
  }

  process.stdout.write(`reviewd: plugin ${installed} installed and current\n`)
}

export interface InitOptions {
  dryRun?: boolean
  yes?: boolean
  /** Asks the question. Injected so the tests never wait on a terminal. */
  confirm?: () => Promise<boolean>
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  try {
    const plan = await planInit()

    if (!plan.harness) {
      // Not a failure worth an exit code on --dry-run: nothing was going to
      // happen either way, and the message is the useful part.
      process.stdout.write(`${noClaudeMessage()}\n`)
      if (!options.dryRun) process.exitCode = 1
      return
    }

    process.stdout.write(renderPlan(plan))

    if (options.dryRun) {
      process.stdout.write('Nothing was changed (--dry-run).\n')
      return
    }

    if (!(await agreed(options))) {
      process.stdout.write('Nothing was changed.\n')
      return
    }

    process.stdout.write(renderResult(await initPlugin()))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

/**
 * Whether to go ahead.
 *
 * A pipe gets no question. init is run from install scripts and from
 * catchUpPlugin, and a prompt written to something that cannot answer is a
 * hang, which is worse than the surprise the prompt exists to prevent. The
 * plan is printed either way, so a non-terminal run still says what it did.
 */
async function agreed(options: InitOptions): Promise<boolean> {
  if (options.yes) return true
  if (options.confirm) return await options.confirm()
  if (!process.stdin.isTTY) return true

  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^(y|yes)$/i.test((await rl.question('Go ahead? [y/N] ')).trim())
  } finally {
    rl.close()
  }
}

export async function printFingerprint(path: string, json: boolean): Promise<void> {
  const root = await requireRepo(path)
  if (!root) return

  const reading = await diffSource({ id: '', rootPath: root })
  const value = manifestFingerprint(reading.files)
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

  // Read once and keep both halves. The tree is what a commit of this reading
  // would carry, which is what `reviewd observe` compares against afterwards.
  const reading = await diffSource({ id: '', rootPath: root })
  const value = manifestFingerprint(reading.files)

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
  const head = await headSha(root)
  return report(await client.gate(root, value, reading.tree, head), json)
}

/**
 * Says what a commit turned out to carry, after the command that made it.
 *
 * Quiet unless there is something wrong, because it runs after every Bash
 * command and a line of output on each one is noise nobody reads. Never fails
 * the command either: the commit already happened, and a non-zero exit here
 * would report the observation as the command's own failure.
 */
export async function observeCommit(path: string): Promise<void> {
  const root = await repoRoot(path)
  if (!root) return

  // A repository that opted out consumes no approval, so every commit in it
  // reads as one the gate never saw. Saying so on each one blames the gate for
  // a decision somebody made deliberately, and the gate already announces
  // itself off on every commit there.
  if (await gateIsOff(root)) return

  const head = await headSha(root)
  if (!head) return

  const tree = (await gitOut(root, ['rev-parse', 'HEAD^{tree}'])) ?? null
  if (!tree) return

  try {
    const baseUrl = loadClientConfig().base_url
    const client = new Client(baseUrl)
    const result = await client.observe(root, head, tree)

    if (result.finding === 'clean') return

    process.stderr.write(`reviewd: ${result.reason}\n`)
    if (result.reviewUrl) process.stderr.write(`Review: ${result.reviewUrl}\n`)
  } catch {
    // A daemon that is down denies commits at the gate, which is the loud half.
    // Saying so again here would put an error on every command after it.
  }
}

/**
 * Whether this repository opted out, read the way the hook reads it.
 *
 * `--absolute-git-dir` rather than joining `.git` onto the root, because a
 * worktree and a submodule both keep theirs somewhere else entirely.
 */
async function gateIsOff(root: string): Promise<boolean> {
  const gitDir = await gitOut(root, ['rev-parse', '--absolute-git-dir'])
  return gitDir !== null && existsSync(join(gitDir, 'reviewd-gate-off'))
}

async function headSha(root: string): Promise<string | null> {
  return gitOut(root, ['rev-parse', 'HEAD'])
}

/** git output, or null when the command has nothing to say. */
async function gitOut(root: string, args: string[]): Promise<string | null> {
  try {
    const out = (await git(root, args)).trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
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
    await reportPlugin()
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
