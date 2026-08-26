import { describe, expect, it } from 'vitest'
import {
  initPlugin,
  installedPluginVersion,
  marketplaceSource,
  planInit,
  type Backup,
  type Runner,
} from './init.js'

/**
 * A `claude` that records what it was asked and answers from a script.
 *
 * `fails` names the argument that should throw, which is how the branches that
 * matter get driven: a marketplace that is already declared, one pointing
 * somewhere else, and no Claude Code on the machine at all.
 */
function fakeClaude(options: { fails?: string; list?: string; marketplaces?: string } = {}) {
  const calls: string[][] = []

  const run: Runner = async (args) => {
    calls.push(args)
    if (options.fails && args.join(' ').includes(options.fails)) {
      throw new Error(`claude: ${args.join(' ')} failed`)
    }
    if (args[1] === 'marketplace' && args[2] === 'list') return options.marketplaces ?? ''
    return args[1] === 'list' ? (options.list ?? '') : ''
  }

  return { run, calls }
}

/** Never touches the real ~/.claude. Records what would have been copied. */
function fakeBackups() {
  const copied: [string, string][] = []
  const backup: Backup = async (from, to) => {
    copied.push([from, to])
    return true
  }
  return { backup, copied }
}

const listing = (source: string) => `Configured marketplaces:

  ❯ bamsammich
    Source: ${source}
`

const onGitHub = listing('GitHub (bamsammich/reviewd)')
const onACheckout = listing('/Users/t/ghq/github.com/bamsammich/reviewd')

const init = (run: Runner, backup: Backup) => initPlugin(run, { stamp: 'STAMP', backup })

describe('initPlugin', () => {
  it('adds the marketplace the first time, when nothing is declared', async () => {
    const claude = fakeClaude()
    const backups = fakeBackups()

    const result = await init(claude.run, backups.backup)

    expect(result.marketplace).toBe('add')
    expect(claude.calls).toContainEqual(['plugin', 'marketplace', 'add', 'bamsammich/reviewd'])
    expect(claude.calls).toContainEqual(['plugin', 'install', 'reviewd@bamsammich', '--yes'])
  })

  /** The ordinary case: every run after the first, including every upgrade. */
  it('updates the marketplace when it already points at the right source', async () => {
    const claude = fakeClaude({ marketplaces: onGitHub })
    const backups = fakeBackups()

    const result = await init(claude.run, backups.backup)

    expect(result.marketplace).toBe('update')
    expect(claude.calls).toContainEqual(['plugin', 'marketplace', 'update', 'bamsammich'])
    expect(claude.calls.some((c) => c[2] === 'add')).toBe(false)
    expect(claude.calls.some((c) => c[2] === 'remove')).toBe(false)
  })

  /**
   * The 2026-08-25 migration. A `bamsammich` marketplace left over from a local
   * checkout updates without complaint and keeps serving the old source, so the
   * plugin never comes from GitHub and nothing says why. It needed a manual
   * `claude plugin marketplace remove` to unstick.
   */
  it('repoints the marketplace when it points somewhere else', async () => {
    const claude = fakeClaude({ marketplaces: onACheckout })
    const backups = fakeBackups()

    const result = await init(claude.run, backups.backup)

    expect(result.marketplace).toBe('repoint')
    expect(claude.calls).toContainEqual(['plugin', 'marketplace', 'remove', 'bamsammich'])
    expect(claude.calls).toContainEqual(['plugin', 'marketplace', 'add', 'bamsammich/reviewd'])
    expect(claude.calls.some((c) => c[2] === 'update')).toBe(false)
  })

  /** Installing every time is what makes re-running the upgrade path. */
  it('installs the plugin on every run', async () => {
    const claude = fakeClaude({ marketplaces: onGitHub })
    const backups = fakeBackups()

    await init(claude.run, backups.backup)
    await init(claude.run, backups.backup)

    expect(claude.calls.filter((c) => c[1] === 'install')).toHaveLength(2)
  })

  it('says so when claude is not on PATH, rather than failing at the marketplace', async () => {
    const claude = fakeClaude({ fails: '--version' })
    const backups = fakeBackups()

    await expect(init(claude.run, backups.backup)).rejects.toThrow(/no supported agent harness/)
    expect(claude.calls.some((c) => c[0] === 'plugin')).toBe(false)
    // Nothing was going to change, so nothing was copied either.
    expect(backups.copied).toEqual([])
  })

  /**
   * Before anything runs, not between the two `claude` calls. A backup taken
   * partway describes a state that never existed on disk.
   */
  it('backs up every file it names, timestamped, before touching anything', async () => {
    const claude = fakeClaude({ marketplaces: onGitHub })
    const backups = fakeBackups()

    const result = await init(claude.run, backups.backup)

    expect(backups.copied).toHaveLength(result.paths.length)
    for (const [from, to] of backups.copied) {
      expect(to).toBe(`${from}.reviewd-backup-STAMP`)
    }
    expect(result.backups).toEqual(backups.copied)
  })

  it('reports a file that was not there as not backed up', async () => {
    const claude = fakeClaude({ marketplaces: onGitHub })

    const result = await initPlugin(claude.run, { stamp: 'STAMP', backup: async () => false })

    expect(result.backups).toEqual([])
    expect(result.paths.length).toBeGreaterThan(0)
  })
})

describe('planInit', () => {
  it('changes nothing, whatever it finds', async () => {
    const claude = fakeClaude({ marketplaces: onACheckout })

    const plan = await planInit(claude.run, '9.9.9')

    expect(plan.marketplace.action).toBe('repoint')
    expect(plan.plugin.version).toBe('9.9.9')
    expect(
      claude.calls.every((c) => c[2] === 'list' || c[1] === 'list' || c[0] === '--version'),
    ).toBe(true)
  })

  it('reports no harness rather than throwing when claude is missing', async () => {
    const claude = fakeClaude({ fails: '--version' })

    const plan = await planInit(claude.run, '1.0.0')

    expect(plan.harness).toBeUndefined()
    expect(plan.marketplace.action).toBe('add')
  })
})

describe('marketplaceSource', () => {
  it('unwraps the GitHub form', async () => {
    expect(await marketplaceSource(fakeClaude({ marketplaces: onGitHub }).run)).toBe(
      'bamsammich/reviewd',
    )
  })

  /** A directory has no parentheses to unwrap, and is reported as written. */
  it('reports a checkout path as itself', async () => {
    expect(await marketplaceSource(fakeClaude({ marketplaces: onACheckout }).run)).toBe(
      '/Users/t/ghq/github.com/bamsammich/reviewd',
    )
  })

  it('is undefined when the marketplace is not declared', async () => {
    const claude = fakeClaude({
      marketplaces: 'Configured marketplaces:\n\n  ❯ other\n    Source: x\n',
    })
    expect(await marketplaceSource(claude.run)).toBeUndefined()
  })
})

describe('installedPluginVersion', () => {
  const plugins = `Installed plugins:

  ❯ reviewd@bamsammich
    Version: 0.1.0
    Scope: user
    Status: ✔ enabled
`

  it('reads the version out of the listing', async () => {
    const claude = fakeClaude({ list: plugins })
    expect(await installedPluginVersion(claude.run)).toBe('0.1.0')
  })

  it('is undefined when the plugin is not installed', async () => {
    const claude = fakeClaude({
      list: 'Installed plugins:\n\n  ❯ other@elsewhere\n    Version: 2\n',
    })
    expect(await installedPluginVersion(claude.run)).toBeUndefined()
  })

  /**
   * A manifest with no version lists as "unknown", which would compare unequal
   * to every real version and reinstall on every session.
   */
  it('is undefined when the listing says unknown', async () => {
    const claude = fakeClaude({ list: '  ❯ reviewd@bamsammich\n    Version: unknown\n' })
    expect(await installedPluginVersion(claude.run)).toBeUndefined()
  })

  it('is undefined when claude cannot be run', async () => {
    const claude = fakeClaude({ fails: 'plugin list' })
    expect(await installedPluginVersion(claude.run)).toBeUndefined()
  })
})
