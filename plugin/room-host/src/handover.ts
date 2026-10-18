// Handover on the room host's side (PLAN.md §5, phase 3).
//
//   the old host's room host   announceHandover: a `handover` entry naming the
//                              successor; the app refuses changes from then on
//   the successor's room host  importRoom: the room as the successor's mod
//                              mirrored it, seqs and all, then a `host` entry
//                              saying up to where the log was carried over
//
// Members move by joining the new room host again (src/joins.ts lets a member
// of the roster back in on their SSH signature, in the role they had).

import { loginKey } from '../../protocol/join.ts'
import { slotModels } from '../../protocol/models.ts'
import type { HandoverData, HostChangeData, ImportRoomRequest, ImportRoomResponse, LogEntry } from '../../protocol/types.ts'
import type { Db } from './db/index.ts'
import { appendLog } from './log.ts'
import { addMember, isVerifiedMember, openRoom } from './rooms.ts'
import { insertTask } from './tasks.ts'
import { fail, now, sha256 } from './util.ts'

export function announceHandover(db: Db, roomId: string, to: string): LogEntry {
  return db.tx(() => {
    const room = openRoom(db, roomId)
    const login = loginKey(to)
    if (login === room.hostLogin) fail(400, 'the host cannot hand the room over to themselves')
    if (!isVerifiedMember(db, room.id, login)) fail(409, `${login} is not a verified member of the room`)
    const data: HandoverData = { change: 'handover', from: room.hostLogin, to: login }
    return appendLog(db, room.id, 'system', null, `${room.hostLogin} hands the room over to ${login}`, data)
  })
}

// The room, carried on here: everything the successor's mirror held. The host
// person gets a session; the other members are in the roster without one and
// join again. Nothing is merged into a room that exists here already.
export function importRoom(db: Db, input: ImportRoomRequest): ImportRoomResponse {
  return db.tx(() => {
    const { room } = input
    const host = loginKey(input.hostLogin)
    if (db.one('SELECT 1 FROM rooms WHERE id = ?', room.id) !== undefined) fail(409, 'this room host has that room already')
    if (db.one('SELECT 1 FROM rooms WHERE name = ? AND closed_at IS NULL', room.name) !== undefined) fail(409, 'a room with that name is open here')
    if (room.visibility === 'private' && input.roomKey === null) fail(400, 'a private room is carried on only with its key')
    const hostMember = input.members.find(member => loginKey(member.login) === host)
    if (hostMember === undefined || !hostMember.verified) fail(400, `${host} is not a verified member of the room`)

    const seqs = input.log.map(entry => entry.seq)
    if (seqs.some((seq, at) => at > 0 && seq <= (seqs[at - 1] ?? 0))) fail(400, 'the log is not in seq order')
    const importedUpTo = seqs.at(-1) ?? 0
    if (input.state.coordinatorCursor > importedUpTo) fail(400, "the coordinator's cursor is past the log")

    const models = slotModels(room.models)
    db.run(
      `INSERT INTO rooms (id, name, visibility, repo_url, base_branch, models, host_login, created_at, key_hash, secret) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      room.id, room.name, room.visibility, room.repoUrl, room.baseBranch ?? null,
      Object.keys(models).length === 0 ? null : JSON.stringify(models), host, room.createdAt,
      input.roomKey === null ? null : sha256(input.roomKey), input.roomSecret,
    )
    const { status } = input
    db.run(
      'INSERT INTO room_status (room_id, doing, decided, planned, blocked, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      room.id, status.doing, JSON.stringify(status.decided), JSON.stringify(status.planned), JSON.stringify(status.blocked), now(),
    )
    const { state } = input
    db.run(
      'INSERT INTO room_state (room_id, version, coordinator_cursor, doc, debounce_ms, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      room.id, state.version, state.coordinatorCursor,
      JSON.stringify({ goals: state.goals, decisions: state.decisions, questions: state.questions, asks: state.asks }),
      state.debounceMs, now(),
    )
    const from = loginKey(input.from)
    for (const member of input.members) {
      const login = loginKey(member.login)
      db.run(
        'INSERT INTO room_members (room_id, login, role, verified, joined_at, left_at) VALUES (?, ?, ?, ?, ?, ?)',
        room.id, login, member.role, member.verified ? 1 : 0, member.joinedAt, login === from && input.hasLeft ? now() : null,
      )
    }
    for (const task of input.tasks) {
      // A claim by someone no longer in the room goes back on the map.
      const isClaimant = task.claimedBy !== null
        && input.members.some(member => loginKey(member.login) === task.claimedBy)
        && !(task.claimedBy === from && input.hasLeft)
      insertTask(db, isClaimant || task.claimedBy === null ? { ...task, roomId: room.id } : { ...task, roomId: room.id, state: 'open', claimedBy: null })
    }
    for (const entry of input.log) {
      db.run(
        'INSERT INTO room_log (room_id, seq, kind, author, body, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        room.id, entry.seq, entry.kind, entry.author, entry.body, entry.data === null ? null : JSON.stringify(entry.data), entry.at,
      )
    }
    const data: HostChangeData = { change: 'host', host, from, importedUpTo, reason: input.reason }
    appendLog(db, room.id, 'system', null, `${host} hosts the room now (${input.reason})`, data)
    const token = addMember(db, room.id, { login: host, role: hostMember?.role ?? 'member', verified: true })
    return { room: openRoom(db, room.id), token }
  })
}
