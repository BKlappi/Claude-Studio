import { loginKey } from '../../plugin/protocol/join.ts'
import { formatStatus } from '../../plugin/protocol/status.ts'
import type {
  AdmitRequest,
  HostRoom,
  Member,
  Role,
  Room,
  RoomSnapshot,
  RoomVisibility,
  Task,
  UpdateStatusRequest,
} from '../../plugin/protocol/types.ts'
import type { Db } from './db/index.ts'
import { appendLog, readLog } from './log.ts'
import { fail, newId, now, randomToken, sameSecret, sha256 } from './util.ts'

const ROOM_COLUMNS =
  'id, name, visibility, repo_url AS repoUrl, host_login AS hostLogin, created_at AS createdAt'
const MEMBER_COLUMNS = 'login, role, verified, joined_at AS joinedAt'
export const TASK_COLUMNS =
  'id, room_id AS roomId, title, spec, state, difficulty, claimed_by AS claimedBy, ' +
  'created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt, version'

const ROOM_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,47}$/u
const TOUCH_WINDOW_MS = 15 * 60 * 1000
const DONE_TASKS_SHOWN_MS = 24 * 60 * 60 * 1000

// Who a session token speaks for: one member of one room.
export type Caller = { login: string; role: Role; roomId: string }

export const isAdmin = (role: Role) => role === 'owner' || role === 'admin'

// --- rooms ----------------------------------------------------------------

function roomRow(db: Db, roomId: string) {
  return db.one<Room & { closedAt: number | null }>(
    `SELECT ${ROOM_COLUMNS}, closed_at AS closedAt FROM rooms WHERE id = ?`, roomId,
  )
}

// The room, if it is open: 404 when there is none, 410 once it closed.
export function openRoom(db: Db, roomId: string): Room {
  const row = roomRow(db, roomId) ?? fail(404, 'no such room')
  if (row.closedAt !== null) fail(410, 'the room is closed')
  const { closedAt, ...room } = row
  return room
}

export function openRoomCount(db: Db): number {
  return db.one<{ n: number }>('SELECT COUNT(*) AS n FROM rooms WHERE closed_at IS NULL')?.n ?? 0
}

export function createRoom(
  db: Db,
  input: { name: string; visibility: RoomVisibility; repoUrl: string | null; login: string; role: Role },
): { room: Room; token: string; roomKey: string | null } {
  const name = input.name.trim()
  if (!ROOM_NAME.test(name)) fail(400, 'room names are 1-48 letters, digits, spaces, _ . -')
  if (input.visibility === 'private' && !isAdmin(input.role)) fail(403, 'only owners and admins create private rooms')
  const login = loginKey(input.login)

  return db.tx(() => {
    if (db.one('SELECT 1 FROM rooms WHERE name = ? AND closed_at IS NULL', name) !== undefined) {
      fail(409, 'a room with that name is open')
    }
    const room: Room = {
      id: newId(),
      name,
      visibility: input.visibility,
      repoUrl: input.repoUrl,
      hostLogin: login,
      createdAt: now(),
    }
    // A private room's key goes out once, here; the host keeps its hash.
    const roomKey = room.visibility === 'private' ? randomToken() : null
    db.run(
      `INSERT INTO rooms (id, name, visibility, repo_url, host_login, created_at, key_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      room.id, room.name, room.visibility, room.repoUrl, room.hostLogin, room.createdAt,
      roomKey === null ? null : sha256(roomKey),
    )
    db.run('INSERT INTO room_status (room_id, updated_at) VALUES (?, ?)', room.id, now())
    appendLog(db, room.id, 'system', login, `${login} created the room and hosts it`, { change: 'created' })
    // The host person is on their own machine: verified by definition.
    const token = addMember(db, room.id, { login, role: input.role, verified: true })
    return { room, token, roomKey }
  })
}

// Whether `roomKey` is the private room's key (an open room has none).
export function roomKeyMatches(db: Db, roomId: string, roomKey: string): boolean {
  const row = db.one<{ keyHash: string | null }>('SELECT key_hash AS keyHash FROM rooms WHERE id = ?', roomId)
  return row?.keyHash != null && sameSecret(sha256(roomKey), row.keyHash)
}

// Closes the room for everyone. Sessions stay, so members hear 410, not 401.
export function closeRoom(db: Db, roomId: string, reason: string): void {
  db.tx(() => {
    const room = openRoom(db, roomId)
    db.run('UPDATE rooms SET closed_at = ? WHERE id = ?', now(), room.id)
    db.run('DELETE FROM file_touches WHERE room_id = ?', room.id)
    appendLog(db, room.id, 'system', null, `room closed: ${reason}`, { change: 'closed' })
  })
}

export function hostRooms(db: Db): HostRoom[] {
  return db
    .all<Room>(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE closed_at IS NULL ORDER BY created_at`)
    .map(room => ({ ...room, members: membersOf(db, room.id) }))
}

// --- members and sessions ---------------------------------------------------

type MemberRow = Omit<Member, 'verified'> & { verified: number }

// In joining order (the successor order of phase 3); joins within the same
// millisecond keep the order they were written in.
function membersOf(db: Db, roomId: string): Member[] {
  return db
    .all<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} FROM room_members WHERE room_id = ? AND left_at IS NULL ORDER BY joined_at, rowid`,
      roomId,
    )
    .map(row => ({ ...row, verified: row.verified === 1 }))
}

export const isVerifiedMember = (db: Db, roomId: string, login: string) =>
  db.one('SELECT 1 FROM room_members WHERE room_id = ? AND login = ? AND left_at IS NULL AND verified = 1', roomId, login) !== undefined

const isPresent = (db: Db, roomId: string, login: string) =>
  db.one('SELECT 1 FROM room_members WHERE room_id = ? AND login = ? AND left_at IS NULL', roomId, login) !== undefined

// Adds or re-adds a member and issues their session token (D9): one per
// member per room, so a new one replaces the old.
function addMember(db: Db, roomId: string, input: AdmitRequest): string {
  const login = loginKey(input.login)
  db.run(
    `INSERT INTO room_members (room_id, login, role, verified, key_fingerprint, joined_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (room_id, login) DO UPDATE SET
       role = excluded.role,
       verified = excluded.verified,
       key_fingerprint = excluded.key_fingerprint,
       joined_at = CASE WHEN room_members.left_at IS NULL THEN room_members.joined_at ELSE excluded.joined_at END,
       left_at = NULL`,
    roomId, login, input.role, input.verified ? 1 : 0, input.keyFingerprint ?? null, now(),
  )
  db.run('DELETE FROM sessions WHERE room_id = ? AND login = ?', roomId, login)
  const token = randomToken()
  db.run('INSERT INTO sessions (token_hash, room_id, login, created_at) VALUES (?, ?, ?, ?)', sha256(token), roomId, login, now())
  return token
}

// The host lets someone in: after the join handshake checked their SSH
// signature and repo permission (PLAN.md phase 1), or by hand.
//
// Someone unverified never takes the place of a verified member: that would
// end the real person's session and hand their name to whoever asked.
export function admit(db: Db, roomId: string, input: AdmitRequest): { room: Room; token: string } {
  return db.tx(() => {
    const room = openRoom(db, roomId)
    const login = loginKey(input.login)
    const wasPresent = isPresent(db, room.id, login)
    if (!input.verified && isVerifiedMember(db, room.id, login)) {
      fail(409, `${login} is in the room, verified by SSH key: only that key gets them in again (or the host removes them first)`)
    }
    const token = addMember(db, room.id, input)
    if (!wasPresent) {
      const how = input.verified ? '' : ' (admitted by hand, not verified)'
      appendLog(db, room.id, 'system', null, `${login} joined${how}`, { change: 'joined', login, verified: input.verified })
    }
    return { room, token }
  })
}

function endMembership(db: Db, roomId: string, login: string): void {
  db.run('UPDATE room_members SET left_at = ? WHERE room_id = ? AND login = ?', now(), roomId, login)
  db.run('DELETE FROM sessions WHERE room_id = ? AND login = ?', roomId, login)
  db.run('DELETE FROM file_touches WHERE room_id = ? AND login = ?', roomId, login)
}

export function kick(db: Db, roomId: string, login: string): void {
  db.tx(() => {
    const room = openRoom(db, roomId)
    const key = loginKey(login)
    if (key === room.hostLogin) fail(409, 'the host cannot be removed: close the room instead')
    if (!isPresent(db, room.id, key)) fail(404, `${key} is not in the room`)
    endMembership(db, room.id, key)
    appendLog(db, room.id, 'system', null, `${key} was removed by the host`, { change: 'removed', login: key })
  })
}

// The last member out closes the room (D18). The host leaves last: handing
// hosting to someone else arrives in PLAN.md phase 3.
export function leaveRoom(db: Db, caller: Caller): { isClosed: boolean } {
  return db.tx(() => {
    const room = openRoom(db, caller.roomId)
    const others = db.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND left_at IS NULL AND login != ?',
      room.id, caller.login,
    )?.n ?? 0
    if (caller.login === room.hostLogin && others > 0) {
      fail(409, 'you host this room and others are still in it: they leave first (handover arrives in phase 3)')
    }
    endMembership(db, room.id, caller.login)
    appendLog(db, room.id, 'system', caller.login, `${caller.login} left`, { change: 'left', login: caller.login })
    if (others > 0) return { isClosed: false }
    closeRoom(db, room.id, 'the last member left')
    return { isClosed: true }
  })
}

type CallerRow = Caller & { closedAt: number | null }

// undefined: no such session (never issued, left, removed). 'closed': the
// session's room has closed.
export function callerForToken(db: Db, token: string): Caller | 'closed' | undefined {
  const row = db.one<CallerRow>(
    `SELECT s.login, m.role, s.room_id AS roomId, r.closed_at AS closedAt
     FROM sessions s
     JOIN room_members m ON m.room_id = s.room_id AND m.login = s.login AND m.left_at IS NULL
     JOIN rooms r ON r.id = s.room_id
     WHERE s.token_hash = ?`,
    sha256(token),
  )
  if (row === undefined) return undefined
  if (row.closedAt !== null) return 'closed'
  return { login: row.login, role: row.role, roomId: row.roomId }
}

// --- messages, status, files ------------------------------------------------

export function postMessage(db: Db, caller: Caller, body: string) {
  const text = body.trim()
  if (text === '') fail(400, 'empty message')
  return appendLog(db, caller.roomId, 'message', caller.login, text)
}

type StatusRow = { version: number; doing: string; decided: string; planned: string; blocked: string }

export function statusText(db: Db, room: Room): string {
  const row = db.one<StatusRow>('SELECT version, doing, decided, planned, blocked FROM room_status WHERE room_id = ?', room.id)
  const touching = db.all<{ path: string }>(
    'SELECT DISTINCT path FROM file_touches WHERE room_id = ? AND at > ? ORDER BY path',
    room.id, now() - TOUCH_WINDOW_MS,
  )
  return formatStatus({
    room: room.name,
    version: row?.version ?? 0,
    doing: row?.doing ?? '',
    touching: touching.map(t => t.path),
    decided: JSON.parse(row?.decided ?? '[]'),
    planned: JSON.parse(row?.planned ?? '[]'),
    blocked: JSON.parse(row?.blocked ?? '[]'),
  })
}

export function updateStatus(db: Db, caller: Caller, patch: UpdateStatusRequest): string {
  return db.tx(() => {
    const room = openRoom(db, caller.roomId)
    const sets: string[] = []
    const values: string[] = []
    if (patch.doing !== undefined) { sets.push('doing = ?'); values.push(patch.doing) }
    for (const key of ['decided', 'planned', 'blocked'] as const) {
      const value = patch[key]
      if (value !== undefined) { sets.push(`${key} = ?`); values.push(JSON.stringify(value)) }
    }
    if (sets.length > 0) {
      db.run(
        `UPDATE room_status SET ${sets.join(', ')}, version = version + 1, updated_at = ? WHERE room_id = ?`,
        ...values, now(), room.id,
      )
    }
    const text = statusText(db, room)
    appendLog(db, room.id, 'status', caller.login, text)
    return text
  })
}

export function reportFiles(db: Db, caller: Caller, paths: string[]): void {
  db.tx(() => {
    for (const path of paths) {
      db.run(
        `INSERT INTO file_touches (room_id, login, path, at) VALUES (?, ?, ?, ?)
         ON CONFLICT (room_id, login, path) DO UPDATE SET at = excluded.at`,
        caller.roomId, caller.login, path, now(),
      )
    }
  })
}

// --- snapshot -------------------------------------------------------------

export function snapshot(db: Db, caller: Caller, since: number): RoomSnapshot {
  const room = openRoom(db, caller.roomId)
  const tasks = db.all<Task>(
    `SELECT ${TASK_COLUMNS} FROM tasks
     WHERE room_id = ? AND (state != 'done' OR updated_at > ?)
     ORDER BY created_at`,
    room.id, now() - DONE_TASKS_SHOWN_MS,
  )
  const log = readLog(db, room.id, since)
  return {
    room,
    members: membersOf(db, room.id),
    tasks,
    log,
    statusText: statusText(db, room),
    cursor: log.at(-1)?.seq ?? since,
  }
}
