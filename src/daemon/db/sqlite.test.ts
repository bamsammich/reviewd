import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSqlite, type KyselySqliteDatabase } from './sqlite.js'

/**
 * These tests cover the adapter directly rather than through Kysely.
 *
 * Everything else in the suite reaches sqlite through query builders, which is
 * the right altitude for testing reviews and threads and the wrong one for
 * testing this: a query builder exercises the adapter only where the
 * application happens to go, and reports a break as a failure somewhere else
 * entirely. The contract Kysely relies on is six methods wide. It is cheap to
 * state it here, once, in the terms Kysely actually calls it in.
 */

let dir: string
let db: KyselySqliteDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reviewd-sqlite-'))
  db = openSqlite(join(dir, 'test.db'))
  db.prepare('create table t (id integer primary key, name text, n integer, maybe text)').run([])
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('reader', () => {
  /**
   * Kysely reads `reader` to choose between `all` and `run`. Getting it wrong
   * on a select returns no rows and reports success, which is the failure this
   * whole file exists to catch.
   */
  it('is true for statements that return rows', () => {
    expect(db.prepare('select * from t').reader).toBe(true)
    expect(db.prepare('select count(*) as c from t').reader).toBe(true)
    expect(db.prepare('insert into t (name) values (?) returning id').reader).toBe(true)
  })

  it('is false for statements that return none', () => {
    expect(db.prepare('insert into t (name) values (?)').reader).toBe(false)
    expect(db.prepare('update t set name = ?').reader).toBe(false)
    expect(db.prepare('delete from t').reader).toBe(false)
  })

  /**
   * Kysely issues these as raw statements through the same path when a
   * transaction opens and closes, so they travel as writes.
   */
  it('is false for the transaction statements Kysely sends', () => {
    expect(db.prepare('begin').reader).toBe(false)
    expect(db.prepare('commit').reader).toBe(false)
    expect(db.prepare('rollback').reader).toBe(false)
  })
})

describe('parameters', () => {
  /** Kysely passes one array; node:sqlite takes them variadically. */
  it('binds an array of parameters positionally', () => {
    db.prepare('insert into t (name, n) values (?, ?)').run(['first', 1])
    db.prepare('insert into t (name, n) values (?, ?)').run(['second', 2])

    const rows = db.prepare('select name from t where n > ? order by n').all([1])
    expect(rows).toEqual([{ name: 'second' }])
  })

  it('binds an empty array', () => {
    expect(db.prepare('select count(*) as c from t').all([])).toEqual([{ c: 0 }])
  })

  it('round-trips null in both directions', () => {
    db.prepare('insert into t (name, maybe) values (?, ?)').run(['n', null])
    expect(db.prepare('select maybe from t where maybe is null').all([])).toEqual([{ maybe: null }])
  })

  it('round-trips text that is not ascii', () => {
    db.prepare('insert into t (name) values (?)').run(['🙂 café'])
    expect(db.prepare('select name from t').all([])).toEqual([{ name: '🙂 café' }])
  })
})

describe('run', () => {
  it('reports the row count it changed', () => {
    db.prepare('insert into t (name) values (?)').run(['a'])
    db.prepare('insert into t (name) values (?)').run(['b'])

    expect(db.prepare('update t set n = 1').run([]).changes).toBe(2)
  })

  it('reports the id it inserted', () => {
    const first = db.prepare('insert into t (name) values (?)').run(['a'])
    const second = db.prepare('insert into t (name) values (?)').run(['b'])

    expect(Number(first.lastInsertRowid)).toBe(1)
    expect(Number(second.lastInsertRowid)).toBe(2)
  })
})

describe('iterate', () => {
  it('yields every row', () => {
    for (const name of ['a', 'b', 'c']) {
      db.prepare('insert into t (name) values (?)').run([name])
    }

    const seen = [...db.prepare('select name from t order by name').iterate([])]
    expect(seen).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
  })
})

describe('errors', () => {
  /**
   * A failed write has to arrive as a thrown error. Swallowed, a constraint
   * violation would read to the caller as a write that happened.
   */
  it('throws on a constraint violation', () => {
    db.prepare('insert into t (id, name) values (?, ?)').run([1, 'a'])
    expect(() => db.prepare('insert into t (id, name) values (?, ?)').run([1, 'b'])).toThrow()
  })

  it('throws on invalid sql', () => {
    expect(() => db.prepare('select * from nonexistent')).toThrow()
  })
})

describe('pragmas', () => {
  /**
   * WAL is the one that has to hold: the daemon serves long-poll readers while
   * a submission writes, and rollback journalling would block them.
   */
  it('leaves a file database in WAL', () => {
    expect(db.prepare('pragma journal_mode').all([])).toEqual([{ journal_mode: 'wal' }])
  })

  it('enforces foreign keys', () => {
    expect(db.prepare('pragma foreign_keys').all([])).toEqual([{ foreign_keys: 1 }])
  })

  /**
   * ':memory:' cannot be in WAL. It is the path the test suite opens most, so
   * what matters is that asking for WAL there is not an error.
   */
  it('opens :memory: without failing on the WAL pragma', () => {
    const memory = openSqlite(':memory:')
    memory.prepare('create table x (a)').run([])
    memory.prepare('insert into x values (?)').run([1])
    expect(memory.prepare('select a from x').all([])).toEqual([{ a: 1 }])
    memory.close()
  })
})
