import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, test } from 'node:test'
import type {
  AdmitResponse,
  CreateRoomResponse,
  HostRoom,
  LogEntry,
  MeResponse,
  RoomSnapshot,
  Task,
} from '../../plugin/protocol/types.ts'
import { MAX_BODY_BYTES, createApp } from '../src/app.ts'
import { SCHEMA_VERSION, openDb } from '../src/db/index.ts'
import type { Db } from '../src/db/index.ts'

const HOST_KEY = 'host-key-for-tests'
const REPO = 'https://github.com/acme/app'

type App = ReturnType<typeof createApp>

function call(app: App, method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {}
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return app.request(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function json<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text())
  return (await response.json()) as T
}

describe('room host', () => {
  let db: Db
  let app: App
  let closedRooms: string[]
  let closeRequests: number

  beforeEach(() => {
    db = openDb(':memory:')
    closedRooms = []
    closeRequests = 0
    app = createApp({
      db,
      hostKey: HOST_KEY,
      onRoomClosed: roomId => closedRooms.push(roomId),
      onClose: () => {
        closeRequests++
      },
    })
  })

  const host = (method: string, path: string, body?: unknown) => call(app, method, path, { token: HOST_KEY, body })
  const member = (token: string, method: string, path: string, body?: unknown) => call(app, method, path, { token, body })

  const createRoom = async (name = 'db work', extra: object = {}) =>
    json<CreateRoomResponse>(
      await host('POST', '/host/rooms', { name, login: 'Ben', role: 'owner', repoUrl: REPO, ...extra }),
      201,
    )

  const admit = async (roomId: string, login: string, extra: object = {}) =>
    json<AdmitResponse>(await host('POST', `/host/rooms/${roomId}/members`, { login, role: 'member', verified: true, ...extra }), 201)

  const snapshotOf = async (token: string, roomId: string, since = 0) =>
    json<RoomSnapshot>(await member(token, 'GET', `/v1/rooms/${roomId}/snapshot?since=${since}`))

  test('host routes need the host key; member routes need a session', async () => {
    const { token } = await createRoom()
    assert.equal((await call(app, 'GET', '/host/rooms')).status, 401)
    assert.equal((await call(app, 'GET', '/host/rooms', { token: 'wrong' })).status, 401)
    assert.equal((await call(app, 'GET', '/host/rooms', { token })).status, 401)
    assert.equal((await call(app, 'GET', '/v1/me')).status, 401)
    assert.equal((await call(app, 'GET', '/v1/me', { token: HOST_KEY })).status, 401)
    assert.equal((await call(app, 'GET', '/health')).status, 200)
  })

  test('the host creates a room and admits a member; they share the task map', async () => {
    const { room, token: ben } = await createRoom()
    assert.equal(room.hostLogin, 'ben')
    assert.equal(room.repoUrl, REPO)
    const { token: ana } = await admit(room.id, 'ana')

    const me = await json<MeResponse>(await member(ana, 'GET', '/v1/me'))
    assert.deepEqual({ login: me.login, role: me.role, room: me.room.id }, { login: 'ana', role: 'member', room: room.id })

    const task = await json<Task>(await member(ben, 'POST', `/v1/rooms/${room.id}/tasks`, { title: 'users migration' }), 201)
    assert.equal(task.createdBy, 'ben')

    const claims = await Promise.all([
      member(ana, 'POST', `/v1/rooms/${room.id}/tasks/${task.id}/claim`),
      member(ben, 'POST', `/v1/rooms/${room.id}/tasks/${task.id}/claim`),
    ])
    assert.deepEqual(claims.map(response => response.status).sort(), [200, 409])

    const snap = await snapshotOf(ben, room.id)
    assert.deepEqual(snap.members.map(m => [m.login, m.verified]), [['ben', true], ['ana', true]])
    const winner = snap.tasks[0]?.claimedBy
    assert.ok(winner === 'ana' || winner === 'ben')
    assert.ok(snap.log.some(entry => entry.body === 'ana joined' && entry.author === null))
    assert.ok(snap.log.some(entry => entry.body === `${winner} claimed: users migration` && entry.author === winner))

    assert.deepEqual((await snapshotOf(ben, room.id, snap.cursor)).log, [])

    const rooms = await json<HostRoom[]>(await host('GET', '/host/rooms'))
    assert.deepEqual(rooms.map(r => [r.name, r.members.length]), [['db work', 2]])
  })

  test('a session token opens its own room only', async () => {
    const a = await createRoom('frontend')
    const b = await createRoom('backend')
    const { token: ana } = await admit(a.room.id, 'ana')
    const task = await json<Task>(await member(b.token, 'POST', `/v1/rooms/${b.room.id}/tasks`, { title: 'api' }), 201)

    assert.equal((await member(ana, 'GET', `/v1/rooms/${b.room.id}/snapshot`)).status, 404)
    assert.equal((await member(ana, 'POST', `/v1/rooms/${b.room.id}/messages`, { body: 'hi' })).status, 404)
    // B's task through A's room is not there either.
    assert.equal((await member(ana, 'POST', `/v1/rooms/${a.room.id}/tasks/${task.id}/claim`)).status, 404)
  })

  test('only owners and admins create private rooms', async () => {
    assert.equal((await host('POST', '/host/rooms', { name: 'sec', visibility: 'private', login: 'ben', role: 'member' })).status, 403)
    const { room } = await createRoom('sec', { visibility: 'private', role: 'admin' })
    assert.equal(room.visibility, 'private')
    assert.equal((await host('POST', '/host/rooms', { name: 'sec', login: 'ben', role: 'owner' })).status, 409)
    assert.equal((await host('POST', '/host/rooms', { name: '', login: 'ben', role: 'owner' })).status, 400)
    assert.equal((await host('POST', '/host/rooms', { name: 'x', login: '-not-a-login', role: 'owner' })).status, 400)
  })

  test('someone admitted by hand is marked unverified', async () => {
    const { room, token: ben } = await createRoom()
    await admit(room.id, 'cem', { verified: false })
    const snap = await snapshotOf(ben, room.id)
    assert.deepEqual(snap.members.find(m => m.login === 'cem')?.verified, false)
    assert.ok(snap.log.some(entry => entry.body === 'cem joined (admitted by hand, not verified)'))
  })

  test('admitting again replaces the session; logins ignore case', async () => {
    const { room, token: ben } = await createRoom()
    const first = await admit(room.id, 'Ana')
    const second = await admit(room.id, 'ana')
    assert.equal((await member(first.token, 'GET', '/v1/me')).status, 401)
    assert.equal((await member(second.token, 'GET', '/v1/me')).status, 200)

    const snap = await snapshotOf(ben, room.id)
    assert.deepEqual(snap.members.map(m => m.login), ['ben', 'ana'])
    assert.equal(snap.log.filter(entry => entry.body === 'ana joined').length, 1)
  })

  test('the host leaves last, and the last one out closes the room', async () => {
    const { room, token: ben } = await createRoom()
    const { token: ana } = await admit(room.id, 'ana')
    await member(ana, 'POST', `/v1/rooms/${room.id}/files`, { paths: ['db/seed.sql'] })

    assert.equal((await member(ben, 'POST', `/v1/rooms/${room.id}/leave`)).status, 409)
    assert.equal((await member(ana, 'POST', `/v1/rooms/${room.id}/leave`)).status, 200)
    assert.equal((await member(ana, 'GET', '/v1/me')).status, 401)
    assert.doesNotMatch((await snapshotOf(ben, room.id)).statusText, /seed\.sql/)
    assert.deepEqual(closedRooms, [])

    assert.equal((await member(ben, 'POST', `/v1/rooms/${room.id}/leave`)).status, 200)
    assert.deepEqual(closedRooms, [room.id])
    assert.deepEqual(await json<HostRoom[]>(await host('GET', '/host/rooms')), [])
    // The name is free again.
    await createRoom()
  })

  test('the host removes a member, or closes the room for everyone', async () => {
    const { room, token: ben } = await createRoom()
    const { token: ana } = await admit(room.id, 'ana')
    const { token: cem } = await admit(room.id, 'cem')

    assert.equal((await host('DELETE', `/host/rooms/${room.id}/members/ana`)).status, 200)
    assert.equal((await member(ana, 'GET', '/v1/me')).status, 401)
    assert.equal((await host('DELETE', `/host/rooms/${room.id}/members/ana`)).status, 404)
    assert.equal((await host('DELETE', `/host/rooms/${room.id}/members/ben`)).status, 409)
    assert.ok((await snapshotOf(ben, room.id)).log.some(entry => entry.body === 'ana was removed by the host'))

    assert.equal((await host('POST', `/host/rooms/${room.id}/close`)).status, 200)
    assert.deepEqual(closedRooms, [room.id])
    assert.equal((await member(cem, 'GET', `/v1/rooms/${room.id}/snapshot`)).status, 410)
    assert.equal((await host('POST', `/host/rooms/${room.id}/members`, { login: 'dan', role: 'member', verified: true })).status, 410)
    assert.equal((await host('POST', '/host/rooms/no-such-room/members', { login: 'dan', role: 'member', verified: true })).status, 404)
  })

  test('POST /host/close asks the process to exit', async () => {
    assert.equal((await host('POST', '/host/close')).status, 200)
    assert.equal(closeRequests, 1)
  })

  test('task permissions: claimer, host or admin', async () => {
    const { room, token: ben } = await createRoom()
    const { token: ana } = await admit(room.id, 'ana')
    const { token: cem } = await admit(room.id, 'cem')
    const task = await json<Task>(await member(ben, 'POST', `/v1/rooms/${room.id}/tasks`, { title: 'seed data' }), 201)
    const claimed = await json<Task>(await member(ana, 'POST', `/v1/rooms/${room.id}/tasks/${task.id}/claim`))

    const state = (token: string, version: number) =>
      member(token, 'POST', `/v1/rooms/${room.id}/tasks/${task.id}/state`, { state: 'done', version })
    assert.equal((await member(cem, 'POST', `/v1/rooms/${room.id}/tasks/${task.id}/release`, {})).status, 403)
    assert.equal((await state(cem, claimed.version)).status, 403)
    assert.equal((await state(ana, claimed.version - 1)).status, 409)
    const done = await json<Task>(await state(ana, claimed.version))
    assert.equal(done.state, 'done')
  })

  test('the room log is append-only, down in the database', async () => {
    const { room, token: ben } = await createRoom()
    await json<LogEntry>(await member(ben, 'POST', `/v1/rooms/${room.id}/messages`, { body: 'hello' }), 201)
    assert.throws(() => db.run("UPDATE room_log SET body = 'changed' WHERE room_id = ?", room.id), /append-only/)
    assert.throws(() => db.run('DELETE FROM room_log WHERE room_id = ?', room.id), /append-only/)
  })

  test('file touches feed the status', async () => {
    const { room, token: ben } = await createRoom('db-work')
    await member(ben, 'POST', `/v1/rooms/${room.id}/files`, { paths: ['db/schema.sql', 'db/seed.sql'] })
    assert.match((await snapshotOf(ben, room.id)).statusText, /^touching: db\/schema\.sql, db\/seed\.sql$/m)
  })

  test('request bodies are limited', async () => {
    const { room, token: ben } = await createRoom()
    const response = await member(ben, 'POST', `/v1/rooms/${room.id}/messages`, { body: 'x'.repeat(MAX_BODY_BYTES) })
    assert.equal(response.status, 413)
  })
})

test('migrations run once, and a newer database is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-db-'))
  const path = join(dir, 'room.db')
  try {
    openDb(path).close()
    const raw = new DatabaseSync(path)
    const { user_version } = raw.prepare('PRAGMA user_version').get() as { user_version: number }
    raw.close()
    assert.equal(user_version, SCHEMA_VERSION)

    // Opening again applies nothing (version 1 would fail: its tables exist).
    openDb(path).close()

    const newer = new DatabaseSync(path)
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    newer.close()
    assert.throws(() => openDb(path), /this room host knows/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
