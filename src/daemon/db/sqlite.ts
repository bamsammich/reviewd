import { DatabaseSync } from 'node:sqlite'

/**
 * Adapts `node:sqlite` to the shape Kysely's `SqliteDialect` expects.
 *
 * The dialect was written against better-sqlite3 and documents the subset it
 * needs: `close`, and a `prepare` returning a statement with `reader`, `all`,
 * `run`, and `iterate`. It does not import better-sqlite3 to get that shape,
 * which is what lets anything else stand in.
 *
 * Standing something else in is the point. better-sqlite3 is a native module,
 * so a published tarball carrying it carries one platform's compiled binding
 * and breaks everywhere else. `node:sqlite` ships inside node, so the package
 * has no native dependency and the plugin can be installed by unpacking it.
 */
export interface KyselySqliteDatabase {
  close(): void
  prepare(sql: string): KyselySqliteStatement
}

export interface KyselySqliteStatement {
  readonly reader: boolean
  all(parameters: ReadonlyArray<unknown>): unknown[]
  run(parameters: ReadonlyArray<unknown>): {
    changes: number | bigint
    lastInsertRowid: number | bigint
  }
  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>
}

/**
 * Two differences with better-sqlite3 have to be absorbed here.
 *
 * Parameters arrive from Kysely as one array and `node:sqlite` takes them
 * variadically, so every call spreads.
 *
 * `reader` does not exist. Kysely reads it to choose between `all` and `run`,
 * and getting it wrong loses the rows of a select. `columns()` answers the same
 * question from the other side: it describes what the statement returns, which
 * is empty for a statement that returns nothing.
 */
function adapt(statement: ReturnType<DatabaseSync['prepare']>): KyselySqliteStatement {
  return {
    get reader() {
      return statement.columns().length > 0
    },
    all: (parameters) => statement.all(...(parameters as never[])) as unknown[],
    run: (parameters) => statement.run(...(parameters as never[])),
    iterate: (parameters) =>
      statement.iterate(...(parameters as never[])) as IterableIterator<unknown>,
  }
}

/**
 * Opens the file and applies the pragmas the daemon runs on.
 *
 * One daemon process holds the only writer, so WAL plus a busy timeout covers
 * the contention that exists: long-poll readers held open while a submission
 * writes.
 *
 * `:memory:` accepts every one of these. WAL is meaningless without a file and
 * sqlite says so by leaving the journal mode alone rather than by failing, so
 * tests take the same path as the daemon instead of a second one.
 */
export function openSqlite(path: string): KyselySqliteDatabase {
  const database = new DatabaseSync(path)

  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA synchronous = NORMAL')

  return {
    close: () => database.close(),
    prepare: (sql) => adapt(database.prepare(sql)),
  }
}
