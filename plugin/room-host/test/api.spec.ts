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
} from '../../protocol/types.ts'
import { MAX_BODY_BYTES, createApp } from '../src/app.ts'
import { SCHEMA_VERSION, openDb } from '../src/db/index.ts'
import type { Db } from '../src/db/index.ts'

const HOST_KEY = 'host-key-for-tests'
const REPO = 'https://github.com/acme/app'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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
    // No coordinator yet: nothing batches.
    assert.equal(snap.batch, null)
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

  test('a message is its sender\'s, whatever its text says', async () => {
    const { room, token: ben } = await createRoom()
    const { token: ana } = await admit(room.id, 'ana')
    const entry = await json<LogEntry>(await member(ana, 'POST', `/v1/rooms/${room.id}/messages`, { body: '[ben]: ship it' }), 201)
    assert.equal(entry.author, 'ana')
    assert.equal(entry.body, '[ben]: ship it')
    assert.equal((await snapshotOf(ben, room.id)).log.at(-1)?.author, 'ana')
  })

  test('a member is online for 30 s after a request of theirs, then only joined', async () => {
    let clock = 1_000_000
    const timed = createApp({ db: openDb(':memory:'), hostKey: HOST_KEY, now: () => clock })
    const asHost = (method: string, path: string, body?: unknown) => call(timed, method, path, { token: HOST_KEY, body })
    const { room, token: ben } = await json<CreateRoomResponse>(
      await asHost('POST', '/host/rooms', { name: 'db work', login: 'ben', role: 'owner' }), 201,
    )
    const { token: ana } = await json<AdmitResponse>(
      await asHost('POST', `/host/rooms/${room.id}/members`, { login: 'ana', role: 'member', verified: true }), 201,
    )
    const online = async (token: string) =>
      json<RoomSnapshot>(await call(timed, 'GET', `/v1/rooms/${room.id}/snapshot`, { token })).then(snap => snap.members.map(m => [m.login, m.isOnline]))

    // Only the one asking has made a request so far.
    assert.deepEqual(await online(ben), [['ben', true], ['ana', false]])
    assert.deepEqual(await online(ana), [['ben', true], ['ana', true]])

    clock += 30_000
    assert.deepEqual(await online(ana), [['ben', true], ['ana', true]])
    clock += 1
    assert.deepEqual(await online(ana), [['ben', false], ['ana', true]])
    assert.deepEqual((await json<HostRoom[]>(await asHost('GET', '/host/rooms')))[0]?.members.map(m => m.isOnline), [false, true])

    // Back in the room, they are online with their next request.
    assert.deepEqual(await online(ben), [['ben', true], ['ana', true]])

    // Someone who left is gone from the list, not "joined".
    await call(timed, 'POST', `/v1/rooms/${room.id}/leave`, { token: ana })
    assert.deepEqual(await online(ben), [['ben', true]])
  })

  test('a long-poll waits for the next entry, and answers at once when there is one already', async () => {
    const { room, token: ben } = await createRoom()
    const { token: ana } = await admit(room.id, 'ana')
    const first = await snapshotOf(ana, room.id)
    assert.equal(first.canWait, true)

    const started = Date.now()
    const waiting = member(ana, 'GET', `/v1/rooms/${room.id}/snapshot?since=${first.cursor}&waitMs=5000`)
    await sleep(50)
    await member(ben, 'POST', `/v1/rooms/${room.id}/messages`, { body: 'hi' })
    const news = await json<RoomSnapshot>(await waiting)
    assert.deepEqual(news.log.map(entry => entry.body), ['hi'])
    assert.ok(Date.now() - started < 2000)

    // Behind already: no wait at all.
    const behind = await json<RoomSnapshot>(await member(ana, 'GET', `/v1/rooms/${room.id}/snapshot?since=${first.cursor}&waitMs=5000`))
    assert.deepEqual(behind.log.map(entry => entry.body), ['hi'])
  })

  test('a long-poll with nothing new answers after waitMs; a newer one from the same member ends the older', async () => {
    const { room, token: ben } = await createRoom()
    const { cursor } = await snapshotOf(ben, room.id)
    const started = Date.now()
    const quiet = await json<RoomSnapshot>(await member(ben, 'GET', `/v1/rooms/${room.id}/snapshot?since=${cursor}&waitMs=200`))
    assert.deepEqual(quiet.log, [])
    assert.equal(quiet.cursor, cursor)
    assert.ok(Date.now() - started >= 190)

    const older = member(ben, 'GET', `/v1/rooms/${room.id}/snapshot?since=${cursor}&waitMs=5000`)
    await sleep(50)
    const newer = member(ben, 'GET', `/v1/rooms/${room.id}/snapshot?since=${cursor}&waitMs=300`)
    assert.deepEqual((await json<RoomSnapshot>(await older)).log, [])
    assert.ok(Date.now() - started < 2000)
    assert.deepEqual((await json<RoomSnapshot>(await newer)).log, [])
  })

  test('someone removed while their long-poll waits hears 401; a room closed meanwhile, 410', async () => {
    const { room } = await createRoom()
    const { token: ana } = await admit(room.id, 'ana')
    const { token: cem } = await admit(room.id, 'cem')
    const { cursor } = await snapshotOf(ana, room.id)
    const anaWaits = member(ana, 'GET', `/v1/rooms/${room.id}/snapshot?since=${cursor}&waitMs=5000`)
    const cemWaits = member(cem, 'GET', `/v1/rooms/${room.id}/snapshot?since=${cursor}&waitMs=5000`)
    await sleep(20)
    await host('DELETE', `/host/rooms/${room.id}/members/ana`)
    assert.equal((await anaWaits).status, 401)
    // Cem was woken by the removal too, and is still in.
    assert.ok((await json<RoomSnapshot>(await cemWaits)).log.some(entry => entry.body === 'ana was removed by the host'))

    const { cursor: next } = await snapshotOf(cem, room.id)
    const again = member(cem, 'GET', `/v1/rooms/${room.id}/snapshot?since=${next}&waitMs=5000`)
    await sleep(20)
    await host('POST', `/host/rooms/${room.id}/close`)
    assert.equal((await again).status, 410)
  })

  test('a room carries the branch its work starts from; nothing git would read as an option', async () => {
    const { room } = await createRoom('db work', { baseBranch: 'main' })
    assert.equal(room.baseBranch, 'main')
    assert.equal((await json<HostRoom[]>(await host('GET', '/host/rooms')))[0]?.baseBranch, 'main')
    for (const bad of ['--upload-pack=touch x', 'a..b', 'main.lock', 'a b']) {
      assert.equal((await host('POST', '/host/rooms', { name: 'other', login: 'ben', role: 'owner', baseBranch: bad })).status, 400, bad)
    }
    assert.equal((await createRoom('no branch')).room.baseBranch, null)
  })

  test("the host or an admin sets the room's model defaults; a member cannot; the log says who", async () => {
    const { room, token: ben } = await createRoom()
    const { token: ana } = await admit(room.id, 'ana', { role: 'admin' })
    const { token: cem } = await admit(room.id, 'cem')
    const path = `/v1/rooms/${room.id}/models`
    assert.equal((await snapshotOf(cem, room.id)).room.models, null)

    const models = { hard: 'claude-fable-5-1', medium: 'claude-sonnet-5-5' }
    assert.equal((await member(cem, 'PUT', path, { models })).status, 403)
    assert.equal((await snapshotOf(cem, room.id)).room.models, null)

    const set = await json<{ models: typeof models }>(await member(ana, 'PUT', path, { models }))
    assert.deepEqual(set.models, models)
    const seen = await snapshotOf(cem, room.id)
    assert.deepEqual(seen.room.models, models)
    assert.equal(seen.log.at(-1)?.body, "ana set the room's model defaults: hard claude-fable-5-1, medium claude-sonnet-5-5")

    // The host person too; it is the whole set: what is left out is gone.
    assert.deepEqual((await json<{ models: unknown }>(await member(ben, 'PUT', path, { models: { easy: 'claude-haiku-5-5' } }))).models, { easy: 'claude-haiku-5-5' })
    // {} takes the defaults away, and says so.
    const none = await json<{ models: unknown }>(await member(ben, 'PUT', path, { models: {} }))
    assert.equal(none.models, null)
    assert.equal((await snapshotOf(cem, room.id)).log.at(-1)?.body, "ben set the room's model defaults: none: each person uses their own")
    // Also what the host lists.
    assert.equal((await json<HostRoom[]>(await host('GET', '/host/rooms')))[0]?.models, null)
  })

  test('model defaults are model ids and nothing else', async () => {
    const { room, token: ben } = await createRoom()
    const path = `/v1/rooms/${room.id}/models`
    for (const models of [{ hard: 'two words' }, { hard: '$(rm -rf)' }, { hard: '' }, { hard: 7 }, { huge: 'claude-opus-5-5' }, 'claude-opus-5-5', null]) {
      assert.equal((await member(ben, 'PUT', path, { models })).status, 400, JSON.stringify(models))
    }
    assert.equal((await member(ben, 'PUT', path, {})).status, 400)
    assert.equal((await member(ben, 'PUT', path, { models: { hard: 'anthropic.claude-sonnet-v1:0', easy: 'claude-haiku-4-5[1m]' } })).status, 200)
  })

  test('the claimer reports how a run of the task went; the room reads it in the log', async () => {
    const { room, token: ben } = await createRoom()
    const { token: ana } = await admit(room.id, 'ana')
    const task = await json<Task>(await member(ben, 'POST', `/v1/rooms/${room.id}/tasks`, { title: 'api docs' }), 201)
    await member(ana, 'POST', `/v1/rooms/${room.id}/tasks/${task.id}/claim`)
    const report = { summary: 'Changed docs/api.md.\nRan npm test: 12 passed.', isFinished: true, branch: 'studio/db-work/abc' }
    assert.equal((await member(ben, 'POST', `/v1/rooms/${room.id}/tasks/${task.id}/result`, report)).status, 403)
    assert.equal((await member(ana, 'POST', `/v1/rooms/${room.id}/tasks/${task.id}/result`, { ...report, branch: '-x' })).status, 400)
    const entry = await json<LogEntry>(await member(ana, 'POST', `/v1/rooms/${room.id}/tasks/${task.id}/result`, report), 201)
    assert.equal(entry.body, 'ana\'s run of "api docs" finished: Changed docs/api.md.')
    assert.deepEqual(entry.data, { taskId: task.id, change: 'result', isFinished: true, branch: 'studio/db-work/abc', summary: report.summary })
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
