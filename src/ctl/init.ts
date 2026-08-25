import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Where the plugin is published. The marketplace manifest lives at that root. */
const MARKETPLACE_SOURCE = 'bamsammich/reviewd'
const MARKETPLACE_NAME = 'bamsammich'
const PLUGIN = 'reviewd'

/**
 * Runs `claude` and returns its stdout, or throws if it fails.
 *
 * Injected rather than imported so the tests can drive init without a Claude
 * Code on the machine running them, the same way ensureDaemon takes its spawn.
 */
export type Runner = (args: string[]) => Promise<string>

const runClaude: Runner = async (args) => (await execFileAsync('claude', args)).stdout

export interface InitResult {
  marketplace: 'added' | 'updated'
  plugin: 'installed'
}

/**
 * Registers the plugin with Claude Code.
 *
 * The install is two halves that update on different clocks: npm carries the
 * binary, and Claude Code carries the hook, the skill, and the MCP declaration.
 * Asking a person to keep both current by hand is asking them to discover the
 * mismatch from a hook that misbehaves, so `reviewd init` owns the second half
 * and nothing in the documentation ever says `claude plugin`.
 *
 * Idempotent by design. Re-running after `npm install -g reviewd@latest` is how
 * the plugin catches up, and it is what the MCP server calls for itself when it
 * notices the installed plugin is a different version than the binary running.
 */
export async function initPlugin(run: Runner = runClaude): Promise<InitResult> {
  await requireClaude(run)

  // `marketplace add` fails once the marketplace is already declared, and that
  // failure is the ordinary case on every run after the first. `update` is the
  // one that refreshes an existing declaration, so try it first and fall back.
  let marketplace: InitResult['marketplace'] = 'updated'
  try {
    await run(['plugin', 'marketplace', 'update', MARKETPLACE_NAME])
  } catch {
    await run(['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE])
    marketplace = 'added'
  }

  // --yes because init is run from a shell that may not be a terminal, and the
  // confirmation prompt has nothing to ask a script.
  await run(['plugin', 'install', `${PLUGIN}@${MARKETPLACE_NAME}`, '--yes'])

  return { marketplace, plugin: 'installed' }
}

/**
 * The version of the plugin Claude Code currently holds, or undefined when it
 * holds none.
 *
 * Read rather than assumed, because the copy in the plugin cache is a snapshot
 * taken at install time and does not follow the binary. `claude plugin list`
 * prints the version on its own line under the name, and a plugin whose
 * manifest carried no version prints "unknown", which is not a version to
 * compare against.
 */
export async function installedPluginVersion(run: Runner = runClaude): Promise<string | undefined> {
  let stdout: string
  try {
    stdout = await run(['plugin', 'list'])
  } catch {
    return undefined
  }

  const lines = stdout.split('\n')
  const at = lines.findIndex((line) => line.includes(`${PLUGIN}@${MARKETPLACE_NAME}`))
  if (at === -1) return undefined

  const version = lines
    .slice(at + 1, at + 5)
    .map((line) => /^\s*Version:\s*(\S+)/.exec(line)?.[1])
    .find(Boolean)

  return version === 'unknown' ? undefined : version
}

async function requireClaude(run: Runner): Promise<void> {
  try {
    await run(['--version'])
  } catch {
    throw new Error(
      'reviewd init: `claude` is not on PATH, so the plugin cannot be registered.\n' +
        'Install Claude Code, then run `reviewd init` again.',
    )
  }
}
