#!/usr/bin/env node
import { openDatabase } from './db/index.js'

/**
 * Placeholder entry point. The HTTP server, hardening, and routes arrive with
 * the next task; for now this proves the database opens and migrates where the
 * config says it should.
 */
async function main(): Promise<void> {
  const path =
    process.env['REVIEWD_DB'] ?? `${process.env['HOME'] ?? '.'}/.local/state/reviewd/reviews.db`

  const db = await openDatabase({ path })
  await db.destroy()
  process.stdout.write(`reviewd: database ready at ${path}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`reviewd: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
