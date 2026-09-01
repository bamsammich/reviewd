#!/usr/bin/env node
import { createRequire } from 'node:module'
import { Command, InvalidArgumentError } from 'commander'
import {
  checkGate,
  observeCommit,
  doctor,
  initCommand,
  printFingerprint,
  runMcp,
  waitForSubmission,
} from './ctl/commands.js'
import { z } from 'zod'
import { gateScope, type GateScope } from './protocol.js'
import { runServe } from './daemon/serve.js'

/**
 * One binary.
 *
 * The daemon and the client used to ship as `reviewd` and `reviewctl`. Two
 * names said more about how the source was split into packages than about
 * anything a person needs to know, so both are subcommands of `reviewd` now.
 *
 * Commander rather than `node:util` parseArgs. parseArgs held every flag in one
 * table and so accepted every flag on every command: `reviewd gate --yes` and
 * `reviewd init --bind-public` both parsed and were both silently ignored. The
 * USAGE string labelled flags `init:` and `serve:` by convention and nothing
 * enforced the labels. Declaring a flag on the command that reads the flag is
 * the enforcement, and generated help retires the USAGE constant.
 */

/**
 * The verbs the hook saw, which can be more than one.
 *
 * `git commit -m x && git push` is one Bash command and reaches the hook as
 * one string. Reporting only the first gated verb in it would let the other
 * through: under push gating the commit is waved past, and a push the hook
 * never mentioned goes with it.
 */
function parseGateVerbs(value: string): GateScope[] {
  const verbs = value
    .split(',')
    .map((verb) => verb.trim())
    .filter((verb) => verb.length > 0)

  const parsed = z.array(gateScope).safeParse(verbs)
  if (!parsed.success || parsed.data.length === 0) {
    throw new InvalidArgumentError('must be commit, push, or both separated by a comma')
  }

  return parsed.data
}

/** What each command does, injected so the tests never reach the daemon. */
export interface Handlers {
  init: typeof initCommand
  serve: typeof runServe
  mcp: typeof runMcp
  wait: typeof waitForSubmission
  fingerprint: typeof printFingerprint
  gate: typeof checkGate
  observe: typeof observeCommit
  doctor: typeof doctor
}

const realHandlers: Handlers = {
  init: initCommand,
  serve: runServe,
  mcp: runMcp,
  wait: waitForSubmission,
  fingerprint: printFingerprint,
  gate: checkGate,
  observe: observeCommit,
  doctor,
}

/**
 * `--timeout 30s` is Number('30s'), which is NaN, and `Date.now() < NaN` is
 * false: the wait loop never runs, `timeout` goes to stdout, and the command is
 * gone in milliseconds. The documented workflow backgrounds `reviewd wait` and
 * reads the verdict off the first line, so a typo arrives as "the reviewer sat
 * on the review for an hour". Refuse a bad timeout out loud instead.
 */
function positiveSeconds(value: string): number {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new InvalidArgumentError(`wants a positive number of seconds, not "${value}"`)
  }
  return seconds
}

const version = (): string => {
  // Read rather than hardcoded, because a version string maintained by hand is
  // a version string that is wrong.
  const pkg = createRequire(import.meta.url)('../package.json') as { version?: string }
  return pkg.version ?? 'unknown'
}

const EPILOGUE = `
Whatever can reach the daemon's port can read and comment on reviews. The
default bind is loopback; --bind-public is required to widen that, and the
startup report names what became reachable.

Exit codes for gate: 0 allowed, 1 denied.
Exit codes for wait: 0 answered, 124 timeout, 1 could not ask. The verdict is
the first line of output, because a verdict is not a failure.
`

export function buildProgram(handlers: Handlers = realHandlers): Command {
  const program = new Command('reviewd')
    .description('reviewd - local-first code review')
    .version(version(), '-v, --version', 'Show the version')
    .addHelpText('after', EPILOGUE)
    .showHelpAfterError()

  program
    .command('init')
    .description('Register the plugin with Claude Code, or update it')
    .option('--dry-run', 'Print the plan and change nothing', false)
    .option('--yes', 'Skip the confirmation, for scripts', false)
    .action(async (options: { dryRun: boolean; yes: boolean }) => {
      await handlers.init({ dryRun: options.dryRun, yes: options.yes })
    })

  program
    .command('serve')
    .description('Run the daemon everything else talks to')
    .option('--config <path>', 'Config file, default $XDG_CONFIG_HOME/reviewd/config.json')
    .option('--bind-public', 'Allow binding an address reachable beyond this machine', false)
    .action(async (options: { config?: string; bindPublic: boolean }) => {
      await handlers.serve({
        ...(options.config === undefined ? {} : { configPath: options.config }),
        bindPublic: options.bindPublic,
      })
    })

  program
    .command('mcp')
    .description('Serve the MCP tools an agent drives reviews with')
    .action(async () => {
      await handlers.mcp()
    })

  program
    .command('wait')
    .description('Block until the reviewer submits, then exit')
    .requiredOption('--review <id>', 'Which review to block on')
    .option('--timeout <seconds>', 'How long before giving up', positiveSeconds, 3600)
    .action(async (options: { review: string; timeout: number }) => {
      await handlers.wait(options.review, options.timeout)
    })

  program
    .command('gate')
    .description('Ask whether a commit or push from this repository is approved')
    .argument('[path]', 'Repository to ask about', process.cwd())
    .option('--json', 'Machine-readable output', false)
    // Defaults to commit so a hook from an older plugin keeps working. What a
    // repository actually holds is the daemon's answer; this only says which
    // command the hook saw.
    .option(
      '--for <verbs>',
      'What the hook saw: commit, push, or both separated by a comma',
      parseGateVerbs,
      ['commit'],
    )
    .action(async (path: string, options: { json: boolean; for: GateScope[] }) => {
      await handlers.gate(path, options.json, options.for)
    })

  program
    .command('observe')
    .description('Report a commit the gate did not clear. Quiet when clean')
    .argument('[path]', 'Repository to look at', process.cwd())
    .action(async (path: string) => {
      await handlers.observe(path)
    })

  program
    .command('fingerprint')
    .description('Hash every change against HEAD, tracked or not')
    .argument('[path]', 'Repository to hash', process.cwd())
    .option('--json', 'Machine-readable output', false)
    .action(async (path: string, options: { json: boolean }) => {
      await handlers.fingerprint(path, options.json)
    })

  program
    .command('doctor')
    .description('Check that the daemon answers where links point')
    .action(async () => {
      await handlers.doctor()
    })

  return program
}

/**
 * Runs one invocation.
 *
 * The bare-name case is handled here rather than as a default subcommand.
 * Commander reads a stray word as an argument to whatever action is registered
 * on the program, so giving the program an action turns `reviewd nonsense` into
 * "too many arguments" instead of "unknown command" — which is the one message
 * a typo actually needs.
 */
export async function run(argv: string[], handlers: Handlers = realHandlers): Promise<void> {
  const program = buildProgram(handlers)

  if (argv.length === 0) {
    program.outputHelp()
    return
  }

  await program.parseAsync(argv, { from: 'user' })
}

// `import.meta.main` is false when cli.ts is imported by a test, so building
// the program stays separable from running the program.
if (import.meta.main) {
  await run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`reviewd: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
