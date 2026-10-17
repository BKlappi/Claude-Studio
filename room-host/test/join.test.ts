// The join handshake (src/joins.ts): nonce, signature against GitHub's key
// list, repo permission, room key, and the host person's say when proof or
// permission is missing.

import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { joinMessage } from '../../plugin/protocol/join.ts'
import type {
  CreateRoomResponse,
  JoinAdmitted,
  JoinNonceResponse,
  JoinPending,
  JoinTicketResponse,
  PendingJoin,
  RoomSnapshot,
} from '../../plugin/protocol/types.ts'
import { ghAccess } from '../src/access.ts'
import type { CheckAccess, Gh, RepoAccess } from '../src/access.ts'
import { createApp } from '../src/app.ts'
import { openDb } from '../src/db/index.ts'
import { JOIN_LIMITS, NONCE_TTL_MS } from '../src/joins.ts'
import { ed25519Key } from './keys.ts'
import type { TestKey } from './keys.ts'

const HOST_KEY = 'host-key-for-tests'
const LOCAL = 'http://127.0.0.1:9'
const PUBLIC = 'https://quiet-river.trycloudflare.com'
const REPO = 'https://github.com/acme/app'

type App = ReturnType<typeof createApp>

function call(app: App, method: string, path: string, options: { token?: string; body?: unknown; client?: string } = {}) {
  const headers: Record<string, string> = { 'cf-connecting-ip': options.client ?? '203.0.113.7' }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return app.request(path, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
}

async function json<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text())
  return (await response.json()) as T
}

describe('joining a room', () => {
  let app: App
  let clock: number
  let keys: Map<string, string[]>
  let access: Map<string, RepoAccess>
  let ana: TestKey

  beforeEach(() => {
    clock = 1_000_000
    ana = ed25519Key()
    keys = new Map([['ana', [ed25519Key().line, ana.line]], ['cem', [ed25519Key().line]]])
    access = new Map<string, RepoAccess>([
      ['ana', { kind: 'role', role: 'member', permission: 'write' }],
      ['rea', { kind: 'refused', permission: 'read' }],
    ])
    const checkAccess: CheckAccess = async (repo, login) => {
      assert.deepEqual(repo, { owner: 'acme', name: 'app' })
      return access.get(login) ?? { kind: 'unknown', reason: 'gh is not installed on the host' }
    }
    app = createApp({
      db: openDb(':memory:'),
      hostKey: HOST_KEY,
      localOrigins: () => [LOCAL],
      checkAccess,
      githubKeys: async login => keys.get(login.toLowerCase()) ?? (login === 'rea' ? [ana.line] : null),
      now: () => clock,
    })
  })

  const host = (method: string, path: string, body?: unknown) => call(app, method, path, { token: HOST_KEY, body })

  const createRoom = async (extra: object = {}) =>
    json<CreateRoomResponse>(await host('POST', '/host/rooms', { name: 'frontend', login: 'ben', role: 'owner', repoUrl: REPO, ...extra }), 201)

  const nonceFor = async (roomId: string, client?: string) =>
    (await json<JoinNonceResponse>(await call(app, 'POST', '/join/nonce', { body: { roomId }, client }))).nonce

  // The joiner's side: nonce, sign, post.
  async function join(roomId: string, options: { login?: string; key?: TestKey | null; origin?: string; signedOrigin?: string; roomKey?: string } = {}) {
    const login = options.login ?? 'ana'
    const origin = options.origin ?? LOCAL
    const nonce = await nonceFor(roomId)
    const key = options.key === undefined ? ana : options.key
    const signature = key === null
      ? null
      : key.sign(joinMessage({ roomId, origin: options.signedOrigin ?? origin, login, nonce }))
    return call(app, 'POST', '/join', {
      body: { roomId, origin, login, nonce, signature, noProof: key === null ? 'no SSH key' : undefined, roomKey: options.roomKey },
    })
  }

  const snapshotOf = async (token: string, roomId: string) =>
    json<RoomSnapshot>(await call(app, 'GET', `/v1/rooms/${roomId}/snapshot`, { token }))

  test('a collaborator with write access who signs is let in, verified', async () => {
    const { room, token: ben } = await createRoom()
    const admitted = await json<JoinAdmitted>(await join(room.id), 201)
    assert.deepEqual(
      { status: admitted.status, login: admitted.login, role: admitted.role, verified: admitted.verified, room: admitted.room.id },
      { status: 'admitted', login: 'ana', role: 'member', verified: true, room: room.id },
    )
    assert.equal((await call(app, 'GET', '/v1/me', { token: admitted.token })).status, 200)
    const snap = await snapshotOf(ben, room.id)
    assert.deepEqual(snap.members.map(m => [m.login, m.verified]), [['ben', true], ['ana', true]])
    assert.ok(snap.log.some(entry => entry.body === 'ana joined'))
  })

  test('a nonce is good for one try, for its room, for two minutes', async () => {
    const { room } = await createRoom()
    const other = await createRoom({ name: 'backend' })
    const post = (nonce: string, roomId = room.id) =>
      call(app, 'POST', '/join', {
        body: { roomId, origin: LOCAL, login: 'ana', nonce, signature: ana.sign(joinMessage({ roomId, origin: LOCAL, login: 'ana', nonce })) },
      })

    const used = await nonceFor(room.id)
    assert.equal((await post(used)).status, 201)
    assert.equal((await post(used)).status, 401)

    assert.equal((await post(await nonceFor(other.room.id))).status, 401)

    const late = await nonceFor(room.id)
    clock += NONCE_TTL_MS
    assert.equal((await post(late)).status, 401)

    assert.equal((await call(app, 'POST', '/join/nonce', { body: { roomId: '00000000-0000-4000-8000-000000000000' } })).status, 404)
  })

  test('a read-only collaborator is refused', async () => {
    const { room, token: ben } = await createRoom()
    const refused = await join(room.id, { login: 'rea' })
    assert.equal(refused.status, 403)
    assert.match(((await refused.json()) as { error: string }).error, /rea has read access to acme\/app; rooms need write access/)
    assert.deepEqual((await snapshotOf(ben, room.id)).members.map(m => m.login), ['ben'])
  })

  test('no such GitHub account, the host\'s own login, a malformed login: refused', async () => {
    const { room } = await createRoom()
    assert.equal((await join(room.id, { login: 'nobody-here' })).status, 403)
    assert.equal((await join(room.id, { login: 'ben' })).status, 409)
    const nonce = await nonceFor(room.id)
    assert.equal((await call(app, 'POST', '/join', { body: { roomId: room.id, origin: LOCAL, login: '-x-', nonce, signature: null } })).status, 400)
  })

  test('a signature made for another address is no proof: the host decides', async () => {
    // A host that relays Ana's signature, made for its own address, to this one.
    const { room } = await createRoom()
    const pending = await json<JoinPending>(await join(room.id, { signedOrigin: 'https://evil.example' }), 202)
    assert.match(pending.reason, /SSH proof failed \(signature does not match\)/)
  })

  test('only the addresses the host set, and its own loopback one, are accepted', async () => {
    const { room } = await createRoom()
    assert.equal((await join(room.id, { origin: PUBLIC })).status, 400)
    assert.equal((await host('PUT', '/host/origins', { origins: [`${PUBLIC}/`] })).status, 200)
    assert.equal((await join(room.id, { origin: PUBLIC.toUpperCase() })).status, 201)
    assert.equal((await host('PUT', '/host/origins', { origins: ['not an origin'] })).status, 400)
    assert.equal((await call(app, 'PUT', '/host/origins', { body: { origins: [] } })).status, 401)
  })

  test('without proof, the request waits for the host person, who admits it unverified', async () => {
    const { room, token: ben } = await createRoom()
    const pending = await json<JoinPending>(await join(room.id, { key: null }), 202)
    assert.equal(pending.reason, 'no SSH proof (they say: "no SSH key")')

    const ticket = `/join/tickets/${pending.ticket}`
    assert.deepEqual(await json<JoinTicketResponse>(await call(app, 'GET', ticket)), { status: 'pending', reason: pending.reason })

    const [waiting] = await json<PendingJoin[]>(await host('GET', '/host/joins'))
    assert.ok(waiting)
    assert.deepEqual({ login: waiting.login, verified: waiting.verified, roomId: waiting.roomId }, { login: 'ana', verified: false, roomId: room.id })
    assert.equal((await call(app, 'GET', '/host/joins')).status, 401)

    assert.equal((await host('POST', `/host/joins/${waiting.id}/admit`, {})).status, 200)
    assert.equal((await host('POST', `/host/joins/${waiting.id}/admit`, {})).status, 404)
    assert.deepEqual(await json<PendingJoin[]>(await host('GET', '/host/joins')), [])

    const admitted = await json<JoinTicketResponse>(await call(app, 'GET', ticket))
    assert.equal(admitted.status, 'admitted')
    if (admitted.status !== 'admitted') return
    assert.deepEqual([admitted.role, admitted.verified], ['member', false])
    // Handed over once.
    assert.equal((await call(app, 'GET', ticket)).status, 404)
    const snap = await snapshotOf(ben, room.id)
    assert.ok(snap.log.some(entry => entry.body === 'ana joined (admitted by hand, not verified)'))
  })

  test('nobody unverified takes the place of a verified member', async () => {
    const { room } = await createRoom()
    const { token } = await json<JoinAdmitted>(await join(room.id), 201)
    assert.equal((await join(room.id, { key: null })).status, 409)
    assert.equal((await join(room.id, { key: ed25519Key() })).status, 409)
    const byHand = await host('POST', `/host/rooms/${room.id}/members`, { login: 'ana', role: 'member', verified: false })
    assert.equal(byHand.status, 409)
    assert.equal((await call(app, 'GET', '/v1/me', { token })).status, 200)
    // Proof again is fine: a new session for the same person.
    assert.equal((await join(room.id)).status, 201)
    assert.equal((await call(app, 'GET', '/v1/me', { token })).status, 401)
  })

  test('the joiner\'s own reason is shown as theirs, on one line', async () => {
    const { room } = await createRoom()
    const nonce = await nonceFor(room.id)
    const pending = await json<JoinPending>(await call(app, 'POST', '/join', {
      body: { roomId: room.id, origin: LOCAL, login: 'cem', nonce, signature: null, noProof: 'x") (verified\nreally' },
    }), 202)
    assert.equal(pending.reason, 'no SSH proof (they say: "x ) (verified really")')
  })

  test('a key GitHub does not list is no proof; the host may refuse', async () => {
    const { room } = await createRoom()
    const pending = await json<JoinPending>(await join(room.id, { login: 'cem' }), 202)
    assert.match(pending.reason, /key is not one the GitHub account lists/)
    const [waiting] = await json<PendingJoin[]>(await host('GET', '/host/joins'))
    assert.equal((await host('POST', `/host/joins/${waiting?.id}/refuse`)).status, 200)
    assert.deepEqual(
      await json<JoinTicketResponse>(await call(app, 'GET', `/join/tickets/${pending.ticket}`)),
      { status: 'refused', reason: 'the host did not let you in' },
    )
  })

  test('proof without a permission answer waits too, and is admitted verified', async () => {
    const { room, token: ben } = await createRoom()
    keys.set('dan', [ana.line])
    const pending = await json<JoinPending>(await join(room.id, { login: 'dan' }), 202)
    assert.equal(pending.reason, 'gh is not installed on the host')
    const [waiting] = await json<PendingJoin[]>(await host('GET', '/host/joins'))
    assert.equal(waiting?.verified, true)
    await host('POST', `/host/joins/${waiting?.id}/admit`, { role: 'admin' })
    const admitted = await json<JoinTicketResponse>(await call(app, 'GET', `/join/tickets/${pending.ticket}`))
    assert.deepEqual(admitted.status === 'admitted' && [admitted.role, admitted.verified], ['admin', true])
    assert.deepEqual((await snapshotOf(ben, room.id)).members.find(m => m.login === 'dan')?.verified, true)
  })

  test('a room with no GitHub repo: every join waits for the host person', async () => {
    const { room } = await createRoom({ repoUrl: undefined })
    const pending = await json<JoinPending>(await join(room.id), 202)
    assert.equal(pending.reason, 'the room has no GitHub repo to check access in')
  })

  test('a newer request replaces an older one; waiting requests expire', async () => {
    const { room } = await createRoom()
    const first = await json<JoinPending>(await join(room.id, { key: null }), 202)
    const second = await json<JoinPending>(await join(room.id, { key: null }), 202)
    assert.equal((await call(app, 'GET', `/join/tickets/${first.ticket}`)).status, 404)
    assert.equal((await json<PendingJoin[]>(await host('GET', '/host/joins'))).length, 1)
    clock += 10 * 60_000
    assert.equal((await call(app, 'GET', `/join/tickets/${second.ticket}`)).status, 404)
    assert.deepEqual(await json<PendingJoin[]>(await host('GET', '/host/joins')), [])
  })

  test('a private room needs its key, from the invite link', async () => {
    const open = await createRoom()
    assert.equal(open.roomKey, null)
    const { room, roomKey } = await createRoom({ name: 'security', visibility: 'private' })
    assert.ok(roomKey !== null && roomKey.length >= 43)

    assert.equal((await join(room.id)).status, 403)
    assert.equal((await join(room.id, { roomKey: `${roomKey.slice(0, -1)}${roomKey.endsWith('A') ? 'B' : 'A'}` })).status, 403)
    assert.equal((await join(room.id, { roomKey })).status, 201)
  })

  test('join attempts are rate limited', async () => {
    const { room } = await createRoom()
    const statuses: number[] = []
    for (let i = 0; i <= JOIN_LIMITS.joinsPerLogin; i++) statuses.push((await join(room.id, { login: 'rea' })).status)
    assert.deepEqual(statuses.slice(0, -1), Array(JOIN_LIMITS.joinsPerLogin).fill(403))
    assert.equal(statuses.at(-1), 429)
    // Another login is still welcome; a minute later, this one too.
    assert.equal((await join(room.id)).status, 201)
    clock += 60_000
    assert.equal((await join(room.id, { login: 'rea' })).status, 403)

    const nonces: number[] = []
    for (let i = 0; i <= JOIN_LIMITS.noncesPerClient; i++) {
      nonces.push((await call(app, 'POST', '/join/nonce', { body: { roomId: room.id }, client: '198.51.100.1' })).status)
    }
    assert.equal(nonces.at(-1), 429)
    assert.equal((await call(app, 'POST', '/join/nonce', { body: { roomId: room.id }, client: '198.51.100.2' })).status, 200)
  })
})

describe('repo permission through gh', () => {
  const REPO_OF = { owner: 'acme', name: 'app' }
  const fakeGh = (answers: Record<string, unknown>): Gh => async args => {
    const path = args[1] ?? ''
    return path in answers ? { ok: true, json: answers[path] } : { ok: false, message: 'gh: Not Found (HTTP 404)' }
  }

  test('maps GitHub roles to room roles (D19)', async () => {
    const check = ghAccess(fakeGh({
      'repos/acme/app/collaborators/ana/permission': { permission: 'write', role_name: 'maintain' },
      'repos/acme/app/collaborators/tri/permission': { permission: 'read', role_name: 'triage' },
      'repos/acme/app/collaborators/adm/permission': { permission: 'admin', role_name: 'admin' },
      'repos/acme/app/collaborators/own/permission': { permission: 'admin', role_name: 'admin' },
      'orgs/acme/memberships/own': { role: 'admin', state: 'active' },
      'repos/acme/app/collaborators/acme/permission': { permission: 'admin', role_name: 'admin' },
      'repos/acme/app/collaborators/cus/permission': { permission: 'write', role_name: 'release-manager' },
    }))
    assert.deepEqual(await check(REPO_OF, 'ana'), { kind: 'role', role: 'member', permission: 'maintain' })
    assert.deepEqual(await check(REPO_OF, 'tri'), { kind: 'refused', permission: 'triage' })
    assert.deepEqual(await check(REPO_OF, 'adm'), { kind: 'role', role: 'admin', permission: 'admin' })
    assert.deepEqual(await check(REPO_OF, 'own'), { kind: 'role', role: 'owner', permission: 'admin' })
    assert.deepEqual(await check(REPO_OF, 'acme'), { kind: 'role', role: 'owner', permission: 'admin' })
    assert.deepEqual(await check(REPO_OF, 'cus'), { kind: 'role', role: 'member', permission: 'write' })
    assert.deepEqual(await check(REPO_OF, 'zed'), {
      kind: 'unknown',
      reason: 'GitHub did not say what zed may do in acme/app (gh: Not Found (HTTP 404))',
    })
  })
})
