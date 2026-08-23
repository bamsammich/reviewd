import { v7 as uuidv7 } from 'uuid'

/**
 * UUIDv7 for every primary key: sortable by creation time, safe to mint on the
 * client, and no sequence for SQLite to hand out.
 */
export function newId(): string {
  return uuidv7()
}

export function now(): number {
  return Date.now()
}
