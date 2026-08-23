#!/usr/bin/env node
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import {
  checkGate,
  doctor,
  printFingerprint,
  runMcp,
  waitForSubmission,
} from './ctl/commands.js'
import { runServe } from './daemon/serve.js'

/**
 * One binary.
 *
 * The daemon and the client used to ship as `reviewd` and `reviewctl`, which
 * said more about how the source was split into packages than about anything a
 * person needs to know. They are subcommands of one name now.
 */

const USAGE = `reviewd - local-first code review

Usage: reviewd <command> [options]

Commands:
  serve                     Run the daemon everything else talks to
  mcp                       Serve the MCP tools an agent drives reviews with
  wait --review <id>        Block until the reviewer submits, then exit
  gate [path]               Ask whether a commit in this repository is approved
  fingerprint [path]        Hash every change against HEAD, tracked or not
  doctor                    Check that the daemon answers where links point

Options:
  --config <path>           serve: config file, default $XDG_CONFIG_HOME/reviewd/config.json
  --bind-public             serve: allow binding an address reachable beyond this machine
  --review <id>             wait: which review to block on
  --timeout <seconds>       wait: how long before giving up, default 3600
  --json                    Machine-readable output
  -h, --help                Show this message
  -v, --version             Show the version

Whatever can reach the daemon's port can read and comment on reviews. The
default bind is loopback; --bind-public is required to widen that, and the
startup report names what became reachable.

Exit codes for gate: 0 allowed, 1 denied.
Exit codes for wait: 0 answered, 124 timeout, 1 could not ask. The verdict is
the first line of output, because a verdict is not a failure.
`

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: 'string' },
      'bind-public': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      review: { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: true,
  })

  const [command, target] = positionals

  if (values.version) {
    // Read rather than hardcoded, because a version string maintained by hand
    // is a version string that is wrong.
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: string }
    process.stdout.write(`${pkg.version ?? 'unknown'}\n`)
    return
  }

  if (values.help || !command) {
    process.stdout.write(USAGE)
    return
  }

  switch (command) {
    case 'serve':
      return await runServe({
        configPath: values.config,
        bindPublic: values['bind-public'] ?? false,
      })
    case 'mcp':
      return await runMcp()
    case 'wait':
      return await waitForSubmission(values.review, Number(values.timeout ?? 3600))
    case 'fingerprint':
      return await printFingerprint(target ?? process.cwd(), values.json ?? false)
    case 'gate':
      return await checkGate(target ?? process.cwd(), values.json ?? false)
    case 'doctor':
      return await doctor()
    default:
      process.stderr.write(`reviewd: unknown command "${command}"\n\n${USAGE}`)
      process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`reviewd: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
