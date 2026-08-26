#!/usr/bin/env node
/**
 * Copies package.json's version into plugin/.claude-plugin/plugin.json.
 *
 * The two files each carry a version and nothing kept them in step. That is
 * worse than cosmetic: catchUpPlugin in src/ctl/commands.ts reinstalls the
 * plugin whenever the installed plugin version differs from the binary's, so a
 * package.json bumped on its own makes every session reinstall, forever, and
 * the reinstall never fixes it because the published plugin.json still holds
 * the old number.
 *
 * Wired to npm's `version` lifecycle, which runs after the bump and before the
 * release commit, so the change rides along in that commit rather than becoming
 * a second thing to remember. `npm version patch` is the whole release step.
 *
 * Run by hand with `node scripts/sync-plugin-version.mjs`; exits non-zero and
 * changes nothing with --check, which is what the test asserts against.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginPath = join(root, 'plugin', '.claude-plugin', 'plugin.json')

const wanted = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const current = readFileSync(pluginPath, 'utf8')
const found = JSON.parse(current).version

if (found === wanted) process.exit(0)

if (process.argv.includes('--check')) {
  process.stderr.write(
    `plugin.json is ${found}, package.json is ${wanted}.\n` +
      'Run `node scripts/sync-plugin-version.mjs` to line them up.\n',
  )
  process.exit(1)
}

// Rewritten by line rather than by JSON.stringify so the file keeps its own
// formatting. prettier checks this file in CI, and a re-serialised copy loses
// to it on key order and indentation for a change that only touches one value.
const updated = current.replace(
  /("version"\s*:\s*)"[^"]*"/,
  (_match, prefix) => `${prefix}${JSON.stringify(wanted)}`,
)

if (updated === current) {
  process.stderr.write(`no version field found in ${pluginPath}\n`)
  process.exit(1)
}

writeFileSync(pluginPath, updated)
process.stdout.write(`plugin.json: ${found} -> ${wanted}\n`)
