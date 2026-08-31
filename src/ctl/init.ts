import { execFile } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Where the plugin is published. The marketplace manifest lives at that root. */
const PUBLISHED_SOURCE = 'bamsammich/reviewd'
const MARKETPLACE_NAME = 'bamsammich'
const PLUGIN = 'reviewd'

/**
 * Where init installs the plugin from, which a checkout can redirect.
 *
 * The source was a constant, and initPlugin's repoint branch exists to undo a
 * local checkout, so working on the plugin meant losing the published one.
 * Environment rather than a flag, because catchUpPlugin calls init too.
 */
const marketplaceSourceSetting = (): string =>
  process.env['REVIEWD_MARKETPLACE_SOURCE'] || PUBLISHED_SOURCE

/**
 * Runs `claude` and returns its stdout, or throws if it fails.
 *
 * Injected rather than imported so the tests can drive init without a Claude
 * Code on the machine running them, the same way ensureDaemon takes its spawn.
 */
export type Runner = (args: string[]) => Promise<string>

const runClaude: Runner = async (args) => (await execFileAsync('claude', args)).stdout

/** Copies a file, or reports that there was nothing there to copy. */
export type Backup = (from: string, to: string) => Promise<boolean>

const copyIfPresent: Backup = async (from, to) => {
  try {
    await mkdir(join(to, '..'), { recursive: true })
    await copyFile(from, to)
    return true
  } catch {
    return false
  }
}

/**
 * What init would do to a marketplace that is already declared.
 *
 * `repoint` is the case that bit the 2026-08-25 migration. A marketplace named
 * `bamsammich` left over from a local checkout updates without complaint and
 * keeps serving the old source, so the plugin never comes from GitHub and no
 * message says why. Reading the source first is what tells the three apart.
 */
export type MarketplaceAction = 'add' | 'update' | 'repoint'

export interface InitPlan {
  /** Absent when Claude Code is not installed, which is not an error here. */
  harness?: 'claude-code' | undefined
  marketplace: {
    name: string
    source: string
    action: MarketplaceAction
    /** What the marketplace points at today, when that is not the source. */
    current?: string | undefined
  }
  plugin: { name: string; version: string; installed?: string | undefined }
  /** Every file init may cause Claude Code to rewrite, in the order shown. */
  paths: string[]
}

export interface InitResult {
  marketplace: MarketplaceAction
  /** Which of the two commands ran, since only one of them can upgrade. */
  plugin: 'installed' | 'updated'
  /** Files copied before anything ran, as `original -> backup`. */
  backups: [string, string][]
  paths: string[]
}

const claudeHome = (): string => process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')

/**
 * The files Claude Code rewrites when a plugin is installed.
 *
 * Listed rather than discovered, because the point is to name them to the
 * reader before anything is touched, and a path that only appears once it has
 * already changed is not a plan.
 */
const touchedPaths = (): string[] => {
  const home = claudeHome()
  return [
    join(home, 'settings.json'),
    join(home, 'plugins', 'known_marketplaces.json'),
    join(home, 'plugins', 'installed_plugins.json'),
  ]
}

/** Where the marketplace checkout and the installed plugin copy end up. */
export const installLocations = (): { marketplace: string; plugin: string } => {
  const plugins = join(claudeHome(), 'plugins')
  return {
    marketplace: join(plugins, 'marketplaces', MARKETPLACE_NAME),
    plugin: join(plugins, 'cache', MARKETPLACE_NAME, PLUGIN),
  }
}

/**
 * What the marketplace of this name points at today, or undefined when there
 * is no such marketplace.
 *
 * Parsed out of `claude plugin marketplace list` rather than read from
 * `known_marketplaces.json`, to match how installedPluginVersion already reads
 * `claude plugin list`: the printed output is the interface Claude Code
 * documents, and the JSON beside it is not.
 */
export async function marketplaceSource(run: Runner = runClaude): Promise<string | undefined> {
  let stdout: string
  try {
    stdout = await run(['plugin', 'marketplace', 'list'])
  } catch {
    return undefined
  }

  const lines = stdout.split('\n')
  const at = lines.findIndex((line) => new RegExp(`❯\\s*${MARKETPLACE_NAME}\\s*$`).test(line))
  if (at === -1) return undefined

  // "Source: GitHub (owner/repo)" for a published one, "Source: /some/path"
  // for a checkout. The parenthesised form is the one worth unwrapping; the
  // rest is reported as written so a directory shows up as a directory.
  return lines
    .slice(at + 1, at + 5)
    .map((line) => {
      const source = /^\s*Source:\s*(.+?)\s*$/.exec(line)?.[1]
      return source === undefined ? undefined : (/\((.+)\)\s*$/.exec(source)?.[1] ?? source)
    })
    .find(Boolean)
}

/**
 * This binary's version, which is the version init installs.
 *
 * Read rather than hardcoded: a version maintained by hand is one that is
 * wrong. scripts/sync-plugin-version.mjs keeps plugin.json equal to it.
 */
const ownVersion = (): string => {
  try {
    const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Works out what init would do, without doing any of it.
 *
 * Split from the doing so `--dry-run` and the printed plan are the same
 * answer rather than two descriptions that can disagree.
 */
export async function planInit(run: Runner = runClaude, version = ownVersion()): Promise<InitPlan> {
  const harness = (await hasClaude(run)) ? ('claude-code' as const) : undefined

  let action: MarketplaceAction = 'add'
  let current: string | undefined

  const wanted = marketplaceSourceSetting()

  if (harness) {
    const source = await marketplaceSource(run)
    if (source !== undefined) {
      current = source === wanted ? undefined : source
      action = current === undefined ? 'update' : 'repoint'
    }
  }

  return {
    harness,
    marketplace: { name: MARKETPLACE_NAME, source: wanted, action, current },
    plugin: {
      name: PLUGIN,
      version,
      installed: harness ? await installedPluginVersion(run) : undefined,
    },
    paths: touchedPaths(),
  }
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
 * Catching up means `plugin update`, because `plugin install` declines to touch
 * a plugin that is already there.
 *
 * Non-interactive on purpose: catchUpPlugin calls it mid-session, where there
 * is nobody to answer a prompt. Asking belongs to initCommand.
 */
export async function initPlugin(
  run: Runner = runClaude,
  options: { stamp?: string; backup?: Backup } = {},
): Promise<InitResult> {
  const plan = await planInit(run)
  if (!plan.harness) throw new Error(noClaudeMessage())

  // Before anything runs, not after the first failure. A backup taken between
  // the two `claude` calls describes a state that never existed on disk.
  const backups = await takeBackups(plan.paths, options.stamp, options.backup)

  if (plan.marketplace.action === 'repoint') {
    // `marketplace update` on a marketplace pointing somewhere else succeeds
    // and changes nothing that matters, which is how a stale checkout kept
    // serving the plugin after the source moved to GitHub. Remove and re-add.
    await run(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME])
    await run(['plugin', 'marketplace', 'add', plan.marketplace.source])
  } else if (plan.marketplace.action === 'update') {
    await run(['plugin', 'marketplace', 'update', MARKETPLACE_NAME])
  } else {
    await run(['plugin', 'marketplace', 'add', plan.marketplace.source])
  }

  // `plugin install` refuses to upgrade. On a plugin already installed it
  // prints "already installed" and exits 0, so init reported success while the
  // registration stayed on the old version and the old path. Every upgrade
  // since the mechanism was added was a no-op, including the automatic one in
  // catchUpPlugin, and `doctor` kept advising a command that could not help.
  //
  // `update` is safe on a current plugin: it prints "already at the latest
  // version" and exits 0.
  const plugin = plan.plugin.installed === undefined ? 'installed' : 'updated'

  // --yes on both because init is run from a shell that may not be a terminal,
  // and the confirmation prompt has nothing to ask a script. `plugin update`
  // documents the same requirement `install` does: required when stdin or
  // stdout is not a TTY.
  if (plugin === 'installed') {
    await run(['plugin', 'install', `${PLUGIN}@${MARKETPLACE_NAME}`, '--yes'])
  } else {
    await run(['plugin', 'update', `${PLUGIN}@${MARKETPLACE_NAME}`, '--yes'])
  }

  return { marketplace: plan.marketplace.action, plugin, backups, paths: plan.paths }
}

/**
 * Copies each file next to itself with a timestamp.
 *
 * Beside the original rather than in a backup directory, because the only
 * thing anyone does with one of these is find it later, and the file it
 * belongs to is where they will look.
 */
async function takeBackups(
  paths: string[],
  stamp = new Date().toISOString().replace(/[:.]/g, '-'),
  backup: Backup = copyIfPresent,
): Promise<[string, string][]> {
  const taken: [string, string][] = []

  for (const path of paths) {
    const to = `${path}.reviewd-backup-${stamp}`
    if (await backup(path, to)) taken.push([path, to])
  }

  return taken
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

async function hasClaude(run: Runner): Promise<boolean> {
  try {
    await run(['--version'])
    return true
  } catch {
    return false
  }
}

/**
 * What to say when there is no harness to configure.
 *
 * The gate and the MCP server are both harness-agnostic already, so a machine
 * without Claude Code is not a machine reviewd cannot serve. Printing the
 * wiring is more use than refusing.
 */
export function noClaudeMessage(): string {
  const gate = join(installLocations().plugin, 'hooks', 'reviewd-gate.sh')

  return `reviewd init: no supported agent harness found (looked for \`claude\` on PATH).

Claude Code is the only one init configures today. For anything else, wire it
up by hand — both pieces are harness-agnostic.

MCP server:
{
  "mcpServers": {
    "reviewd": { "type": "stdio", "command": "reviewd", "args": ["mcp"] }
  }
}

Commit gate: run this script as a pre-tool hook on shell commands. It reads the
command as JSON on stdin and answers with a permission decision.
  ${gate}

Install Claude Code and run \`reviewd init\` again to have both done for you.`
}
