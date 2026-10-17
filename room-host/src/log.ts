import type { LogEntry, LogKind } from '../../plugin/protocol/types.ts'
import type { Db } from './db/index.ts'
import { now } from './util.ts'

const FIRST_LOAD_ENTRIES = 100
const MAX_ENTRIES_PER_POLL = 500

// The room log is append-only (the schema's triggers refuse changes): every
// change to a room writes an entry here in the same transaction.
export function appendLog(
  db: Db,
  roomId: string,
  kind: LogKind,
  author: string | null,
  body: string,
  data: unknown = null,
): LogEntry {
  return db.tx(() => {
    const next = db.one<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM room_log WHERE room_id = ?', roomId)
    const entry: LogEntry = { seq: next?.seq ?? 1, roomId, kind, author, body, data, at: now() }
    db.run(
      'INSERT INTO room_log (room_id, seq, kind, author, body, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      roomId, entry.seq, kind, author, body, data === null ? null : JSON.stringify(data), entry.at,
    )
    return entry
  })
}

type LogRow = Omit<LogEntry, 'data'> & { data: string | null }

// since = 0: the latest entries, for a first load. Otherwise everything after
// `since`, up to a page.
export function readLog(db: Db, roomId: string, since: number): LogEntry[] {
  const select = 'SELECT seq, room_id AS roomId, kind, author, body, data, at FROM room_log WHERE room_id = ? AND seq > ?'
  const rows = since === 0
    ? db.all<LogRow>(`SELECT * FROM (${select} ORDER BY seq DESC LIMIT ?) ORDER BY seq`, roomId, since, FIRST_LOAD_ENTRIES)
    : db.all<LogRow>(`${select} ORDER BY seq LIMIT ?`, roomId, since, MAX_ENTRIES_PER_POLL)
  return rows.map(row => ({ ...row, data: row.data === null ? null : JSON.parse(row.data) }))
}
