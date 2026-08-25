import { describe, expect, it } from 'vitest'
import { initPlugin, installedPluginVersion, type Runner } from './init.js'

/**
 * A `claude` that records what it was asked and answers from a script.
 *
 * `fails` names the argument that should throw, which is how the two branches
 * that matter get driven: a marketplace that is already declared, and no Claude
 * Code on the machine at all.
 */
function fakeClaude(options: { fails?: string; list?: string } = {}) {
  const calls: string[][] = []

  const run: Runner = async (args) => {
    calls.push(args)
    if (options.fails && args.join(' ').includes(options.fails)) {
      throw new Error(`claude: ${args.join(' ')} failed`)
    }
    return args[1] === 'list' ? (options.list ?? '') : ''
  }

  return { run, calls }
}

describe('initPlugin', () => {
  it('adds the marketplace the first time, when update finds nothing to update', async () => {
    const claude = fakeClaude({ fails: 'marketplace update' })

    expect(await initPlugin(claude.run)).toEqual({ marketplace: 'added', plugin: 'installed' })
    expect(claude.calls).toContainEqual(['plugin', 'marketplace', 'add', 'bamsammich/reviewd'])
    expect(claude.calls).toContainEqual(['plugin', 'install', 'reviewd@bamsammich', '--yes'])
  })

  /** The ordinary case: every run after the first, including every upgrade. */
  it('updates the marketplace when it is already declared', async () => {
    const claude = fakeClaude()

    expect(await initPlugin(claude.run)).toEqual({ marketplace: 'updated', plugin: 'installed' })
    expect(claude.calls).toContainEqual(['plugin', 'marketplace', 'update', 'bamsammich'])
    expect(claude.calls.some((c) => c[2] === 'add')).toBe(false)
  })

  /** Installing every time is what makes re-running the upgrade path. */
  it('installs the plugin on every run', async () => {
    const claude = fakeClaude()
    await initPlugin(claude.run)
    await initPlugin(claude.run)

    expect(claude.calls.filter((c) => c[1] === 'install')).toHaveLength(2)
  })

  it('says so when claude is not on PATH, rather than failing at the marketplace', async () => {
    const claude = fakeClaude({ fails: '--version' })

    await expect(initPlugin(claude.run)).rejects.toThrow(/`claude` is not on PATH/)
    expect(claude.calls.some((c) => c[0] === 'plugin')).toBe(false)
  })
})

describe('installedPluginVersion', () => {
  const listing = `Installed plugins:

  ❯ reviewd@bamsammich
    Version: 0.1.0
    Scope: user
    Status: ✔ enabled
`

  it('reads the version out of the listing', async () => {
    const claude = fakeClaude({ list: listing })
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
