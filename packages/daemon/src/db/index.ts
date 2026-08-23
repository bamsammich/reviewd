import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { Migrator } from 'kysely/migration'
import { CodeMigrationProvider } from './migrations.js'
import type { Database } from './types.js'

export type { Database } from './types.js'
export { migrations } from './migrations.js'

export interface OpenOptions {
  /** Filesystem path, or ':memory:' for tests that need no durability. */
  path: string
}

/**
 * Opens the database and brings it to the current schema.
 *
 * One daemon process holds the only writer, so WAL plus a busy timeout covers
 * the contention that exists: long-poll readers held open while a submission
 * writes.
 */
export async function openDatabase({ path }: OpenOptions): Promise<Kysely<Database>> {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  const sqlite = new SQLite(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')

  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
  await migrateToLatest(db)
  return db
}

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({ db, provider: new CodeMigrationProvider() })
  const { error, results } = await migrator.migrateToLatest()

  if (error) {
    const failed = results?.find((r) => r.status === 'Error')
    const where = failed ? ` at ${failed.migrationName}` : ''
    throw new Error(`reviewd: migration failed${where}: ${String(error)}`)
  }
}
