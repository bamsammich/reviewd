import { describe, expect, it } from 'vitest'
import { renderPlan, renderResult } from './init-report.js'
import type { InitPlan, InitResult } from './init.js'

const plan = (over: Partial<InitPlan> = {}): InitPlan => ({
  harness: 'claude-code',
  marketplace: { name: 'bamsammich', source: 'bamsammich/reviewd', action: 'update' },
  plugin: { name: 'reviewd', version: '0.1.1' },
  paths: ['/home/t/.claude/settings.json'],
  ...over,
})

describe('renderPlan', () => {
  /**
   * The gate is the whole tool and was the one thing init never mentioned.
   * Installing a commit blocker silently is what gets a tool uninstalled.
   */
  it('says a commit gate is being installed, and how to turn it off', () => {
    const out = renderPlan(plan())

    expect(out).toMatch(/refuses `git commit`/)
    expect(out).toContain('reviewd-gate-off')
  })

  it('names every file it will touch, before touching any', () => {
    expect(renderPlan(plan())).toContain('/home/t/.claude/settings.json')
  })

  it('shows a repoint as a move, naming both ends', () => {
    const out = renderPlan(
      plan({
        marketplace: {
          name: 'bamsammich',
          source: 'bamsammich/reviewd',
          action: 'repoint',
          current: '/Users/t/checkout',
        },
      }),
    )

    expect(out).toContain('REPOINT')
    expect(out).toContain('/Users/t/checkout -> bamsammich/reviewd')
  })

  it('shows an upgrade as a version move', () => {
    const out = renderPlan(
      plan({ plugin: { name: 'reviewd', version: '0.1.1', installed: '0.1.0' } }),
    )
    expect(out).toContain('0.1.0 -> 0.1.1')
  })

  it('shows a same-version run as one version, not a move to itself', () => {
    const out = renderPlan(
      plan({ plugin: { name: 'reviewd', version: '0.1.1', installed: '0.1.1' } }),
    )
    expect(out).not.toContain('->')
  })
})

describe('renderResult', () => {
  const result = (backups: [string, string][]): InitResult => ({
    marketplace: 'update',
    plugin: 'installed',
    backups,
    paths: ['/home/t/.claude/settings.json'],
  })

  it('names the backup path rather than saying a backup was taken', () => {
    const out = renderResult(result([['/home/t/.claude/settings.json', '/home/t/s.json.bak']]))
    expect(out).toContain('/home/t/s.json.bak')
  })

  /** Silence would read as "backed up" to anyone who did not count the lines. */
  it('says outright when there was nothing to back up', () => {
    expect(renderResult(result([]))).toMatch(/nothing/)
  })
})
