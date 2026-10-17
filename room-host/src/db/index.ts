import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

// migrations/NNN-name.sql, applied in order; PRAGMA user_version holds the
// number of the last one applied.
const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url)
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter(name => /^\d{3}-.+\.sql$/.test(name))
  .sort()
  .map(name => ({ version: Number(name.slice(0, 3)), sql: readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8') }))

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0

export type Db = {
  one<T>(sql: string, ...params: SQLInputValue[]): T | undefined
  all<T>(sql: string, ...params: SQLInputValue[]): T[]
  run(sql: string, ...params: SQLInputValue[]): { changes: number }
  tx<T>(fn: () => T): T
  close(): void
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (row.user_version > SCHEMA_VERSION) {
    throw new Error(`database is at schema ${row.user_version}, this room host knows ${SCHEMA_VERSION}`)
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= row.user_version) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

export function openDb(path: string): Db {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  try {
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }

  let depth = 0

  return {
    one: <T>(sql: string, ...params: SQLInputValue[]) =>
      db.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: SQLInputValue[]) =>
      db.prepare(sql).all(...params) as T[],
    run: (sql, ...params) => {
      const result = db.prepare(sql).run(...params)
      return { changes: Number(result.changes) }
    },
    // node:sqlite is synchronous, so a transaction is a plain BEGIN/COMMIT
    // around a synchronous function. Nested calls join the outer one.
    tx: fn => {
      if (depth > 0) return fn()
      depth += 1
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        depth -= 1
      }
    },
    close: () => db.close(),
  }
}
