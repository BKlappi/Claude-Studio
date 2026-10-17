// /room attach (hooks/hosting.ts attachRoomHost): the session uses a room
// host somebody started by hand, a fake one here that answers its /host routes.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { HostRoom, PendingJoin, Room, RoomSnapshot } from '../protocol/types'
import { PANE, START, TYPED, fakeNet, fakeRun, ok } from './fakes'
import type { Call } from './fakes'

const HOST = 'http://127.0.0.1:8787'
const KEY = 'dev-host-key-that-must-stay-out-of-the-transcript'
const ID = '5f0c2a5e-1d2b-4c3a-9e8f-0123456789ab'

const room = (name: string, visibility: 'open' | 'private' = 'open', id = ID): Room => ({
  id,
  name,
  visibility,
  repoUrl: null,
  hostLogin: 'ben',
  createdAt: 1,
})
const hostRoom = (found: Room): HostRoom => ({ ...found, members: [{ login: 'ben', role: 'admin', verified: true, joinedAt: 1 }] })

type World = { rooms?: HostRoom[]; waiting?: PendingJoin[]; env?: Record<string, string> }

function machine(on: On, world: World = {}) {
  const clock = mock.clock(on)
  mock.store(on, { identity: { login: 'ben', keyFile: null, publicKey: null } })
  mock.env(on, world.env ?? { USERPROFILE: 'C:\\Users\\ben', STUDIO_HOST_KEY: KEY })
  const logs: string[] = []
  const toasts: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/code/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  fakeRun(on, () => undefined)

  const rooms = world.rooms ?? []
  const waiting = world.waiting ?? []
  // The hand-run room host: stopped (nothing listens), or started again with another key.
  const roomHost = { isDown: false, key: KEY }
  const calls = fakeNet(on, call => {
    const url = new URL(call.url)
    if (url.origin !== HOST) return undefined
    if (roomHost.isDown) return { fail: `connect ECONNREFUSED 127.0.0.1:8787` }
    if (url.pathname === '/health') return ok({ ok: true })
    if (url.pathname.startsWith('/host/') && call.authorization !== `Bearer ${roomHost.key}`) return { status: 401, body: { error: 'host key required' } }
    if (call.method === 'GET' && url.pathname === '/host/rooms') return ok(rooms)
    if (call.method === 'POST' && url.pathname === '/host/rooms') {
      const input = call.body as { name: string }
      return ok({ room: room(input.name), token: 'created-token', roomKey: null }, 201)
    }
    if (call.method === 'POST' && url.pathname.endsWith('/members')) {
      const found = rooms.find(known => url.pathname === `/host/rooms/${known.id}/members`)
      return found === undefined ? undefined : ok({ room: found, token: 'fresh-token' }, 201)
    }
    if (url.pathname === '/host/joins') return ok(waiting)
    if (url.pathname.endsWith('/admit')) {
      waiting.length = 0
      return ok({ ok: true })
    }
    const current = rooms[0] ?? room('dev')
    if (url.pathname === '/v1/me') return ok({ login: 'ben', role: 'admin', room: current })
    if (url.pathname.endsWith('/snapshot')) {
      const snapshot: RoomSnapshot = { room: current, members: [], tasks: [], log: [], statusText: '', cursor: 0 }
      return ok(snapshot)
    }
    if (url.pathname.endsWith('/leave')) return ok({ ok: true })
    return undefined
  })
  return { clock, logs, toasts, calls, roomHost }
}

async function command($: Engine, command: 'room' | 'studio', args: string) {
  return (await $.command.run({ command, args, ...TYPED })).text ?? ''
}

const hostCalls = (calls: Call[]) => calls.filter(call => new URL(call.url).pathname.startsWith('/host/'))

test('attach with the key from the environment and no room there: a "dev" room is made, the pane and invite follow', async ($, on) => {
  const { clock, logs, calls } = machine(on)
  await $.session.start(START)

  const text = await command($, 'room', 'attach')
  expect(text).toMatch(/^Attached to the room host at http:\/\/127\.0\.0\.1:8787: you are in "dev" as ben \(owner\)\./)
  expect(text).not.toContain(KEY)
  expect(calls.find(call => call.method === 'POST' && call.url === `${HOST}/host/rooms`)?.body).toEqual({
    name: 'dev',
    visibility: 'open',
    login: 'ben',
    role: 'owner',
  })
  await clock.settle()
  expect(await command($, 'studio', 'status')).toMatch(/hosted by ben at http:\/\/127\.0\.0\.1:8787/)

  // Hosting without children: the pane's address line and the invite work.
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: `reachable at ${HOST}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /attached to a room host started by hand/ })).toBeDefined()
  await ui.unmount()

  const invite = await command($, 'room', 'invite')
  expect(invite).toContain(`studio:join?room=${ID}&at=${encodeURIComponent(HOST)}`)
  expect(invite).toMatch(/\nNote: attached to a room host started by hand/)
  expect(JSON.stringify([text, invite, logs])).not.toContain(KEY)
})

test('attach to the one room there is: the host person gets a fresh token, no second room', async ($, on) => {
  const { clock, calls } = machine(on, { rooms: [hostRoom(room('backend'))] })
  await $.session.start(START)

  expect(await command($, 'room', 'attach')).toMatch(/you are in "backend" as ben \(admin\)\./)
  expect(calls.find(call => call.url === `${HOST}/host/rooms` && call.method === 'POST')).toBeUndefined()
  expect(calls.find(call => call.url === `${HOST}/host/rooms/${ID}/members`)?.body).toEqual({ login: 'ben', role: 'admin', verified: true })
  await clock.settle()
  // The room is read with the new token.
  expect(calls.some(call => call.url.includes('/snapshot') && call.authorization === 'Bearer fresh-token')).toBe(true)
})

test('several rooms: --room picks one, and without it the names are listed', async ($, on) => {
  const other = '6a1d3b6f-2e3c-4d4b-8f90-123456789abc'
  const { calls } = machine(on, { rooms: [hostRoom(room('backend')), hostRoom(room('frontend', 'open', other))] })
  await $.session.start(START)

  expect(await command($, 'room', 'attach')).toBe('room attach: 2 rooms are open there ("backend", "frontend"): /room attach --room <name>')
  expect(await command($, 'room', 'attach --room nothing')).toBe('room attach: no open room "nothing" there; open rooms: "backend", "frontend"')
  expect(hostCalls(calls).some(call => call.method === 'POST')).toBe(false)

  expect(await command($, 'room', 'attach --room Frontend')).toMatch(/you are in "frontend" as ben/)
  expect(calls.some(call => call.url === `${HOST}/host/rooms/${other}/members`)).toBe(true)
})

test('attach: a url that is not on this machine never gets the host key', async ($, on) => {
  const { calls } = machine(on)
  await $.session.start(START)

  for (const url of ['https://example.com', 'http://192.168.1.5:8787', 'http://127.0.0.1', 'http://127.0.0.1.evil.example:8787']) {
    const text = await command($, 'room', `attach ${url}`)
    expect(text).toMatch(/is not a room host on this machine: give http:\/\/127\.0\.0\.1:<port>/)
  }
  expect(calls).toEqual([])
})

test('attach: no key, a wrong key, no room host, a private room', async ($, on) => {
  const { calls } = machine(on, { env: { USERPROFILE: 'C:\\Users\\ben' }, rooms: [hostRoom(room('secret', 'private'))] })
  await $.session.start(START)

  expect(await command($, 'room', 'attach')).toMatch(/^The host key is missing: \/room attach <url> <host key>, or set STUDIO_HOST_KEY/)
  expect(calls).toEqual([])
  expect(await command($, 'room', 'attach wrong-key')).toBe(`room attach: ${HOST} did not accept that host key (the room host prints its key when it starts)`)
  expect(await command($, 'room', `attach ${KEY} http://127.0.0.1:9`)).toBe('room attach: no room host answers at http://127.0.0.1:9: start one with pnpm dev')
  expect(await command($, 'room', `attach ${KEY}`)).toMatch(/^room attach: "secret" is private: its key was shown once when it was created/)
  expect(await command($, 'studio', 'status')).toBe('Not in a room.')
})

test('the host person lets someone in through the attached room host', async ($, on) => {
  const waiting: PendingJoin[] = [{ id: 'j1', roomId: ID, login: 'cem', verified: false, reason: 'no SSH proof (no key)', at: 1 }]
  const { clock, calls } = machine(on, { waiting })
  await $.session.start(START)
  await command($, 'room', 'attach')
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'cem wants in (unverified: no SSH proof (no key))' })).toBeDefined()
  await ui.press({ key: 'admit:j1' })
  expect(calls.find(call => call.url === `${HOST}/host/joins/j1/admit`)?.authorization).toBe(`Bearer ${KEY}`)
  await ui.unmount()
})

test('leaving lets go of the room host without stopping it, and the session can attach again', async ($, on) => {
  const { calls } = machine(on)
  await $.session.start(START)
  await command($, 'room', 'attach')
  expect(await command($, 'room', 'attach')).toBe('room attach: this session is attached to a room host already: /room leave first')

  expect(await command($, 'room', 'leave')).toBe('Left the room.')
  // Not its child: the room host is left running.
  expect(calls.some(call => call.url === `${HOST}/host/close`)).toBe(false)
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /reachable at/ })).toBeUndefined()
  await ui.unmount()
  expect(await command($, 'room', 'attach')).toMatch(/^Attached to the room host/)
})

test('the hand-run room host stops: sync says so, /room leave lets go, and a new attach works', async ($, on) => {
  const { clock, calls, roomHost } = machine(on)
  await $.session.start(START)
  await command($, 'room', 'attach')
  await clock.settle()

  roomHost.isDown = true
  await clock.advance(3000)
  await clock.settle()
  expect(await command($, 'studio', 'status')).toMatch(/sync: {3}cannot reach the room host at http:\/\/127\.0\.0\.1:8787/)
  expect(await command($, 'room', 'create "x"')).toBe('room create: this session is attached to a room host already: /room leave first')

  expect(await command($, 'room', 'leave')).toMatch(/^Left the room \(cannot reach the room host at http:\/\/127\.0\.0\.1:8787: .*ECONNREFUSED.*\)\.$/)
  expect(await command($, 'studio', 'status')).toBe('Not in a room.')
  expect(calls.some(call => call.url === `${HOST}/host/close`)).toBe(false)

  roomHost.isDown = false
  expect(await command($, 'room', 'attach')).toMatch(/^Attached to the room host/)
})

test('the hand-run room host comes back with another key: sync says what to do', async ($, on) => {
  const { clock, roomHost } = machine(on)
  await $.session.start(START)
  await command($, 'room', 'attach')
  await clock.settle()

  roomHost.key = 'a-new-key'
  await clock.advance(3000)
  await clock.settle()
  const status = await command($, 'studio', 'status')
  expect(status).toMatch(/sync: {3}the room host no longer takes the host key this session has .*: \/room leave, then \/room attach/)
  expect(status).not.toContain(KEY)
})

test('attach refuses a room whose host is not among its members', async ($, on) => {
  const odd: HostRoom = { ...room('backend'), members: [{ login: 'ana', role: 'owner', verified: true, joinedAt: 1 }] }
  const { calls } = machine(on, { rooms: [odd] })
  await $.session.start(START)

  expect(await command($, 'room', 'attach')).toBe('room attach: "backend" lists ben as its host, but not among its members')
  expect(calls.some(call => call.url.endsWith('/members'))).toBe(false)
})

test('a reload of the mod forgets an attached room and says how to come back', async ($, on) => {
  const toasts: string[] = []
  mock.clock(on)
  mock.store(on, { room: { hostUrl: HOST, roomId: ID, token: 't', login: 'ben', isHost: true, isAttached: true } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/code/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start(START)
  expect(toasts).toEqual(['Studio: a reload of the mod forgot the room you attached to (its room host is still running): /room attach again'])
  expect(await command($, 'studio', 'status')).toBe('Not in a room.')
})
