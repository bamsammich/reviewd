import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Kysely, SqliteDialect } from 'kysely'
import { Migrator } from 'kysely/migration'
import { CodeMigrationProvider } from './migrations.js'
import { openSqlite } from './sqlite.js'
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
 * The connection and its pragmas live in `./sqlite.js`, which is also where the
 * reason the driver is `node:sqlite` rather than better-sqlite3 is written down.
 */
export async function openDatabase({ path }: OpenOptions): Promise<Kysely<Database>> {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: openSqlite(path) }) })
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
