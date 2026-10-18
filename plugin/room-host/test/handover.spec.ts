// Handover on the room host (src/handover.ts): the host proof members check
// before trusting a new address, the old host's handover entry, and the
// successor's room host carrying the room on from a mirror.

import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { joinMessage } from '../../protocol/join.ts'
import { isHostProof } from '../../protocol/seal.ts'
import { parseStatus } from '../../protocol/status.ts'
import type {
  AdmitResponse,
  CreateRoomResponse,
  HostProofResponse,
  ImportRoomRequest,
  ImportRoomResponse,
  JoinAdmitted,
  JoinNonceResponse,
  LogEntry,
  RoomSnapshot,
  Task,
} from '../../protocol/types.ts'
import { createApp } from '../src/app.ts'
import { openDb } from '../src/db/index.ts'
import { ed25519Key } from './keys.ts'
import type { TestKey } from './keys.ts'

const HOST_KEY = 'host-key-for-tests'
const OLD = 'http://127.0.0.1:9'
const NEW = 'http://127.0.0.1:10'
const REPO = 'https://github.com/acme/app'

type App = ReturnType<typeof createApp>

function call(app: App, method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {}
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return app.request(path, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
}

async function json<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text())
  return (await response.json()) as T
}

// What a successor's mod sends: its mirror of the room (hooks/handover.ts).
function mirrorOf(snap: RoomSnapshot, options: { host: string; hasLeft: boolean; roomKey?: string | null }): ImportRoomRequest {
  const status = parseStatus(snap.statusText)
  assert.ok(snap.state !== null && snap.roomSecret !== undefined)
  return {
    room: snap.room,
    hostLogin: options.host,
    from: snap.room.hostLogin,
    reason: options.hasLeft ? `${snap.room.hostLogin} left` : `${snap.room.hostLogin}'s machine stopped answering`,
    hasLeft: options.hasLeft,
    roomSecret: snap.roomSecret,
    roomKey: options.roomKey ?? null,
    members: snap.members.map(({ login, role, verified, joinedAt }) => ({ login, role, verified, joinedAt })),
    tasks: snap.tasks,
    state: snap.state,
    status: { doing: status.doing, decided: status.decided, planned: status.planned, blocked: status.blocked },
    log: snap.log,
  }
}

describe('handover on the room host', () => {
  let oldHost: App
  let newHost: App
  let anaKey: TestKey
  let accessChecks: string[]
  let room: CreateRoomResponse['room']
  let ben: string
  let ana: string
  let cem: string

  const asHost = (app: App, method: string, path: string, body?: unknown) => call(app, method, path, { token: HOST_KEY, body })
  const snap = async (app: App, token: string, since = 0) => json<RoomSnapshot>(await call(app, 'GET', `/v1/rooms/${room.id}/snapshot?since=${since}`, { token }))
  const say = (app: App, token: string, body: string) => call(app, 'POST', `/v1/rooms/${room.id}/messages`, { token, body: { body } })

  beforeEach(async () => {
    anaKey = ed25519Key()
    accessChecks = []
    const make = (origin: string) => createApp({
      db: openDb(':memory:'),
      hostKey: HOST_KEY,
      localOrigins: () => [origin],
      checkAccess: async (_repo, login) => {
        accessChecks.push(login)
        return { kind: 'unknown', reason: 'gh is not installed on the host' }
      },
      githubKeys: async login => (login === 'ana' ? [anaKey.line] : []),
    })
    oldHost = make(OLD)
    newHost = make(NEW)
    const created = await json<CreateRoomResponse>(await asHost(oldHost, 'POST', '/host/rooms', { name: 'frontend', login: 'ben', role: 'owner', repoUrl: REPO }), 201)
    room = created.room
    ben = created.token
    ana = (await json<AdmitResponse>(await asHost(oldHost, 'POST', `/host/rooms/${room.id}/members`, { login: 'ana', role: 'admin', verified: true }), 201)).token
    cem = (await json<AdmitResponse>(await asHost(oldHost, 'POST', `/host/rooms/${room.id}/members`, { login: 'cem', role: 'member', verified: false }), 201)).token
  })

  test('the room host proves it hosts the room, for its own addresses only, with the secret its members hold', async () => {
    const { roomSecret } = await snap(oldHost, ana)
    assert.ok(roomSecret !== undefined && roomSecret.length >= 40)
    const nonce = 'n'.repeat(32)
    const { proof } = await json<HostProofResponse>(await call(oldHost, 'POST', '/host-proof', { body: { roomId: room.id, origin: OLD, nonce } }))
    assert.equal(await isHostProof(roomSecret, { roomId: room.id, origin: OLD, nonce }, proof), true)
    // Bound to the address and the nonce.
    assert.equal(await isHostProof(roomSecret, { roomId: room.id, origin: NEW, nonce }, proof), false)
    assert.equal(await isHostProof(roomSecret, { roomId: room.id, origin: OLD, nonce: 'm'.repeat(32) }, proof), false)
    // A relay at another address gets nothing from it.
    assert.equal((await call(oldHost, 'POST', '/host-proof', { body: { roomId: room.id, origin: 'https://evil.example', nonce } })).status, 400)
    // Its public address once the mod set it.
    await asHost(oldHost, 'PUT', '/host/origins', { origins: ['https://quiet-river.trycloudflare.com'] })
    assert.equal((await call(oldHost, 'POST', '/host-proof', { body: { roomId: room.id, origin: 'https://quiet-river.trycloudflare.com', nonce } })).status, 200)
  })

  test('removing a member makes a new secret: what they knew proves nothing any more', async () => {
    const before = (await snap(oldHost, ana)).roomSecret
    await asHost(oldHost, 'DELETE', `/host/rooms/${room.id}/members/cem`)
    const after = (await snap(oldHost, ana)).roomSecret
    assert.ok(before !== undefined && after !== undefined && before !== after)
  })

  test('members say whether their machine can host; the snapshot carries it', async () => {
    await call(oldHost, 'PUT', `/v1/rooms/${room.id}/me`, { token: ana, body: { canHost: true } })
    await call(oldHost, 'PUT', `/v1/rooms/${room.id}/me`, { token: cem, body: { canHost: false } })
    const members = (await snap(oldHost, ben)).members
    assert.deepEqual(members.map(member => [member.login, member.canHost]), [['ben', undefined], ['ana', true], ['cem', false]])
  })

  test('a handover is written in the log; from then on the room takes no changes, only reads', async () => {
    assert.equal((await asHost(oldHost, 'POST', `/host/rooms/${room.id}/handover`, { to: 'cem' })).status, 409)
    assert.equal((await asHost(oldHost, 'POST', `/host/rooms/${room.id}/handover`, { to: 'ben' })).status, 400)
    const entry = await json<LogEntry>(await asHost(oldHost, 'POST', `/host/rooms/${room.id}/handover`, { to: 'Ana' }), 201)
    assert.deepEqual(entry.data, { change: 'handover', from: 'ben', to: 'ana' })
    assert.equal(entry.author, null)

    const refused = await say(oldHost, cem, 'still here?')
    assert.equal(refused.status, 503)
    assert.match(await refused.text(), /moving to ana's machine/)
    assert.equal((await call(oldHost, 'POST', `/v1/rooms/${room.id}/tasks`, { token: cem, body: { title: 'x' } })).status, 503)
    assert.equal((await call(oldHost, 'POST', '/join/nonce', { body: { roomId: room.id } })).status, 503)
    assert.ok((await snap(oldHost, cem)).log.some(logged => logged.body === 'ben hands the room over to ana'))
  })

  test('the successor carries the room on: its log, seqs, tasks, state and roster; its own session; the others join again', async () => {
    await say(oldHost, ben, 'hello')
    const task = await json<Task>(await call(oldHost, 'POST', `/v1/rooms/${room.id}/tasks`, { token: ben, body: { title: 'dark mode' } }), 201)
    await call(oldHost, 'POST', `/v1/rooms/${room.id}/tasks/${task.id}/claim`, { token: ben })
    const kept = await json<Task>(await call(oldHost, 'POST', `/v1/rooms/${room.id}/tasks`, { token: ana, body: { title: 'login form' } }), 201)
    await call(oldHost, 'POST', `/v1/rooms/${room.id}/tasks/${kept.id}/claim`, { token: ana })
    await asHost(oldHost, 'POST', `/host/rooms/${room.id}/handover`, { to: 'ana' })
    const mirror = await snap(oldHost, ana)

    const imported = await json<ImportRoomResponse>(await asHost(newHost, 'POST', '/host/rooms/import', mirrorOf(mirror, { host: 'ana', hasLeft: true })), 201)
    assert.equal(imported.room.id, room.id)
    assert.equal(imported.room.hostLogin, 'ana')
    const carried = await snap(newHost, imported.token)
    // The log goes on where it was, with one entry saying so.
    assert.deepEqual(carried.log.slice(0, -1).map(entry => [entry.seq, entry.body]), mirror.log.map(entry => [entry.seq, entry.body]))
    const last = carried.log.at(-1)
    assert.equal(last?.seq, mirror.cursor + 1)
    assert.equal(last?.body, 'ana hosts the room now (ben left)')
    assert.deepEqual(last?.data, { change: 'host', host: 'ana', from: 'ben', importedUpTo: mirror.cursor, reason: 'ben left' })
    // Ben left: his claim is back on the map; ana's stands.
    assert.deepEqual(carried.tasks.map(t => [t.title, t.state, t.claimedBy]), [['dark mode', 'open', null], ['login form', 'claimed', 'ana']])
    assert.deepEqual(carried.members.map(member => [member.login, member.role]), [['ana', 'admin'], ['cem', 'member']])
    assert.deepEqual(carried.state, mirror.state)
    // The same secret: members check the new host with what they hold.
    assert.equal(carried.roomSecret, mirror.roomSecret)
    // Old sessions do not open the new room host.
    assert.equal((await call(newHost, 'GET', '/v1/me', { token: cem })).status, 401)
    // New entries carry on numbering.
    const next = await json<LogEntry>(await say(newHost, imported.token, 'I host now'), 201)
    assert.equal(next.seq, mirror.cursor + 2)
    // Not twice.
    assert.equal((await asHost(newHost, 'POST', '/host/rooms/import', mirrorOf(mirror, { host: 'ana', hasLeft: true }))).status, 409)
  })

  test('a successor carries plans and reviews on: subtasks, checks, slots, attempts, the last review', async () => {
    const tasks = (token: string, id: string, action: string, body: unknown = {}) => call(oldHost, 'POST', `/v1/rooms/${room.id}/tasks/${id}/${action}`, { token, body })
    const parent = await json<Task>(await call(oldHost, 'POST', `/v1/rooms/${room.id}/tasks`, { token: ana, body: { title: 'dark mode', difficulty: 'medium', needsPlan: true } }), 201)
    await tasks(ana, parent.id, 'claim')
    const plan = { summary: '', subtasks: [{ title: 'tokens', spec: '', difficulty: 'easy', checks: ['npm test passes'] }, { title: 'toggle', spec: '', difficulty: 'medium', checks: [] }] }
    await json(await tasks(ana, parent.id, 'plan', plan), 201)
    const tokens = (await snap(oldHost, ana)).tasks.find(known => known.title === 'tokens')
    assert.ok(tokens !== undefined)
    await tasks(ana, tokens.id, 'claim')
    for (let fails = 0; fails < 2; fails++) await json(await tasks(ana, tokens.id, 'review', { verdict: 'fail', reasons: ['no test ran'], slot: 'easy' }))
    const mirror = await snap(oldHost, ana)

    const imported = await json<ImportRoomResponse>(await asHost(newHost, 'POST', '/host/rooms/import', mirrorOf(mirror, { host: 'ana', hasLeft: false })), 201)
    const carried = await snap(newHost, imported.token)
    const fields = (task: Task | undefined) => [task?.state, task?.needsPlan, task?.parentId, task?.checks, task?.slot, task?.attempts, task?.failedReviews, task?.review?.reasons]
    assert.deepEqual(carried.tasks.map(fields), mirror.tasks.map(fields))
    assert.deepEqual(fields(carried.tasks.find(known => known.id === tokens.id)), ['claimed', false, parent.id, ['npm test passes'], 'medium', 2, 0, ['no test ran']])
  })

  test("the room's model defaults are carried on; a mirror from before them has none", async () => {
    const models = { hard: 'claude-fable-5-1', easy: 'claude-haiku-5-5' }
    await json(await call(oldHost, 'PUT', `/v1/rooms/${room.id}/models`, { token: ben, body: { models } }))
    const mirror = await snap(oldHost, ana)
    assert.deepEqual(mirror.room.models, models)

    const imported = await json<ImportRoomResponse>(await asHost(newHost, 'POST', '/host/rooms/import', mirrorOf(mirror, { host: 'ana', hasLeft: false })), 201)
    assert.deepEqual(imported.room.models, models)
    assert.deepEqual((await snap(newHost, imported.token)).room.models, models)

    // An older mod's mirror names no models: the room has none, not a failure.
    const older = mirrorOf(await snap(oldHost, ana), { host: 'ana', hasLeft: false })
    const { models: _left, ...bare } = older.room
    const other = createApp({ db: openDb(':memory:'), hostKey: HOST_KEY, localOrigins: () => [NEW] })
    const again = await json<ImportRoomResponse>(await asHost(other, 'POST', '/host/rooms/import', { ...older, room: bare }), 201)
    assert.equal(again.room.models, null)
  })

  test('someone in the carried roster joins the new room host on their signature alone, in their role', async () => {
    await asHost(oldHost, 'POST', `/host/rooms/${room.id}/members`, { login: 'dee', role: 'member', verified: true })
    const mirror = await snap(oldHost, ben)
    // Ben's machine stopped answering: dee carries the room on, ana follows.
    await json<ImportRoomResponse>(await asHost(newHost, 'POST', '/host/rooms/import', mirrorOf(mirror, { host: 'dee', hasLeft: false })), 201)
    const { nonce } = await json<JoinNonceResponse>(await call(newHost, 'POST', '/join/nonce', { body: { roomId: room.id } }))
    const joined = await json<JoinAdmitted>(await call(newHost, 'POST', '/join', {
      body: { roomId: room.id, origin: NEW, login: 'ana', nonce, signature: anaKey.sign(joinMessage({ roomId: room.id, origin: NEW, login: 'ana', nonce })) },
    }), 201)
    assert.deepEqual([joined.login, joined.role, joined.verified], ['ana', 'admin', true])
    // No permission check: the roster says she is in, as what.
    assert.deepEqual(accessChecks, [])
    // Ben stopped answering, not left: he stays in the roster to come back.
    const members = (await snap(newHost, joined.token)).members.map(member => member.login)
    assert.deepEqual(members, ['ben', 'ana', 'cem', 'dee'])
  })

  test('a private room is carried on only with its key; a mirror out of order is refused', async () => {
    const secret = await json<CreateRoomResponse>(await asHost(oldHost, 'POST', '/host/rooms', { name: 'sec', visibility: 'private', login: 'ben', role: 'owner', repoUrl: REPO }), 201)
    await asHost(oldHost, 'POST', `/host/rooms/${secret.room.id}/members`, { login: 'ana', role: 'member', verified: true })
    const mirror = await json<RoomSnapshot>(await call(oldHost, 'GET', `/v1/rooms/${secret.room.id}/snapshot`, { token: secret.token }))
    const request = mirrorOf(mirror, { host: 'ana', hasLeft: true })
    assert.equal((await asHost(newHost, 'POST', '/host/rooms/import', request)).status, 400)
    assert.equal((await asHost(newHost, 'POST', '/host/rooms/import', { ...request, roomKey: secret.roomKey, log: [...request.log].reverse() })).status, 400)
    assert.equal((await asHost(newHost, 'POST', '/host/rooms/import', { ...request, roomKey: secret.roomKey })).status, 201)
  })
})
