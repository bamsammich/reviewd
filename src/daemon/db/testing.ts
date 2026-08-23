import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { openDatabase } from './index.js'
import type { Database } from './types.js'

export interface TempDatabase {
  db: Kysely<Database>
  path: string
  close: () => Promise<void>
}

/**
 * A real on-disk database per test.
 *
 * Tests run against a file rather than ':memory:' because WAL, the busy
 * timeout, and durability across a reopen only exist on disk, and those are
 * exactly the behaviors worth covering.
 */
export async function tempDatabase(): Promise<TempDatabase> {
  const dir = mkdtempSync(join(tmpdir(), 'reviewd-test-'))
  const path = join(dir, 'reviews.db')
  const db = await openDatabase({ path })

  return {
    db,
    path,
    close: async () => {
      await db.destroy()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
