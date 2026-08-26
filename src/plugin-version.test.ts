import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The two version fields have to agree, and nothing else notices when they do
 * not.
 *
 * catchUpPlugin compares the installed plugin's version against the binary's
 * and reinstalls on a mismatch, so a package.json bumped without plugin.json
 * makes every session reinstall the plugin and never converge. It is silent —
 * no test failed, no build broke, the tool just got slower forever.
 *
 * `npm version` runs scripts/sync-plugin-version.mjs, so the release path keeps
 * these lined up on its own. This is the guard for the other path: a version
 * edited by hand.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const versionIn = (...path: string[]): string =>
  JSON.parse(readFileSync(join(root, ...path), 'utf8')).version

describe('plugin version', () => {
  it('matches package.json', () => {
    expect(versionIn('plugin', '.claude-plugin', 'plugin.json')).toBe(versionIn('package.json'))
  })
})
