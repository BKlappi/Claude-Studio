// Handover in the mod (hooks/handover.ts, PLAN.md §5) on a fake machine: an
// old room host that hands over or stops answering, a new one elsewhere that
// proves it holds the room's secret, this machine's own room host when it
// takes over, the directory as a fake git remote.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { hostProof } from '../protocol/seal'
import type { HostChangeData, ImportRoomRequest, LogEntry, Member, Room, RoomSnapshot, Task } from '../protocol/types'
import { PANE, START, TYPED, fakeGit, fakeRun, fakeSpawn } from './fakes'
import type { GitRemote } from './fakes'

const ROOM_ID = '5f0c2a5e-1d2b-4c3a-9e8f-0123456789ab'
const OLD = 'https://old-host.trycloudflare.com'
const NEW = 'https://new-host.trycloudflare.com'
const EVIL = 'https://evil.trycloudflare.com'
const LOCAL = 'http://127.0.0.1:4100'
const TUNNEL = 'https://ana-host.trycloudflare.com'
const SECRET = 'S'.repeat(43)
const ROOM: Room = { id: ROOM_ID, name: 'frontend', visibility: 'open', repoUrl: 'https://github.com/acme/app', hostLogin: 'ben', createdAt: 1 }
const SIGNATURE = '-----BEGIN SSH SIGNATURE-----\nZmFrZQ==\n-----END SSH SIGNATURE-----\n'

const member = (login: string, joinedAt: number, isOnline = true): Member => ({ login, role: 'member', verified: true, joinedAt, isOnline, canHost: true })
const entry = (seq: number, kind: LogEntry['kind'], author: string | null, body: string, data: unknown = null): LogEntry => ({ seq, roomId: ROOM_ID, kind, author, body, data, at: seq })
const listed = (host: string, address: string) => ({ id: ROOM_ID, visibility: 'open', name: 'frontend', host, address, updatedAt: 1 })

type World = {
  me: string
  // This machine can host: Node, the room host's files, cloudflared.
  canHost: boolean
  members?: Member[]
  beforePush?: (remote: GitRemote) => void
}

// The room host at OLD, as members see it until it goes.
function world(on: On, options: World) {
  const clock = mock.clock(on)
  mock.store(on, {
    room: { hostUrl: OLD, roomId: ROOM_ID, token: 'old-token', login: options.me, roomSecret: SECRET, roomMode: false },
    identity: { login: options.me, keyFile: 'C:\\Users\\me\\.ssh\\id_ed25519', publicKey: 'ssh-ed25519 AAAA' },
  })
  mock.env(on, { USERPROFILE: 'C:\\Users\\me' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/code/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: options.canHost }))
  const toasts: string[] = []
  const logs: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))

  const git = fakeGit({ beforePush: options.beforePush })
  git.pushFromElsewhere(JSON.stringify({ version: 1, rooms: [listed('ben', OLD)] }))
  fakeRun(on, ran => {
    const line = ran.argv.join(' ')
    if (line === 'node --version' && options.canHost) return { stdout: 'v24.1.0\n' }
    if (line === 'cloudflared --version' && options.canHost) return { stdout: 'cloudflared version 2026.10.1\n' }
    if (ran.argv[0] === 'ssh-keygen' && ran.argv[1] === '-Y') return { stdout: SIGNATURE }
    return git.answer(ran)
  })
  const children = fakeSpawn(on, child => {
    if (child.argv[0] === 'node' && child.argv[1]?.endsWith('index.ts')) {
      child.say(`{"event":"ready","port":4100,"hostKey":"${child.env?.STUDIO_HOST_KEY}"}\n`)
      return true
    }
    if (child.argv[0] === 'cloudflared') {
      child.say(`INF |  ${TUNNEL}  |\n`, 'stderr')
      child.say('INF Registered tunnel connection connIndex=0\n', 'stderr')
      return true
    }
    return false
  })

  const tasks: Task[] = [
    { id: 't1', roomId: ROOM_ID, title: 'dark mode', spec: '', state: 'claimed', difficulty: null, claimedBy: options.me, createdBy: 'ben', askedBy: ['ben'], createdAt: 1, updatedAt: 1, version: 2 },
  ]
  const old = {
    isDown: false,
    members: options.members ?? [{ ...member('ben', 1), role: 'owner' as const }, member('ana', 2), member('cem', 3), member('dee', 4)],
    log: [entry(1, 'system', 'ben', 'ben created the room and hosts it'), entry(2, 'message', 'ben', 'hello')],
  }
  const state = { version: 1, coordinatorCursor: 1, goals: [], decisions: [], questions: [], asks: [], debounceMs: 4000 }
  const snapshotOf = (room: Room, members: Member[], log: LogEntry[], since: number, extra: Partial<RoomSnapshot> = {}): RoomSnapshot => ({
    room, members, tasks, log: log.filter(logged => logged.seq > since), statusText: 'room: frontend | v0', batch: null,
    state, cursor: log.at(-1)?.seq ?? 0, roomSecret: SECRET, ...extra,
  })

  // The room host that took over at NEW (dee's), and one at EVIL that cannot prove anything.
  const fresh = { log: [] as LogEntry[], posted: [] as string[] }
  const imported: ImportRoomRequest[] = []
  const requests: { url: string; method: string; authorization: string | null; body: unknown }[] = []
  const lookups = new Map<string, number>()
  const answer = (status: number, body: unknown) => ({ value: { status, ok: status < 400, headers: {}, text: JSON.stringify(body) } })

  on('http.fetch', async ($, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    const authorization = e.init?.headers?.authorization ?? null
    const body = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    requests.push({ url: e.url, method, authorization, body })
    const since = Number(url.searchParams.get('since') ?? 0)
    const path = url.pathname

    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name') ?? ''
      const seen = (lookups.get(name) ?? 0) + 1
      lookups.set(name, seen)
      return answer(200, seen < 2 ? { Status: 3 } : { Status: 0, Answer: [{ name, type: 1, data: '104.16.0.1' }] })
    }
    if (url.origin === OLD) {
      if (old.isDown) return { deny: 'connect ECONNREFUSED' }
      if (authorization !== 'Bearer old-token') return answer(401, { error: 'not in this room: join it again' })
      if (path === '/v1/me') return answer(200, { login: options.me, role: 'member', room: ROOM })
      if (path.endsWith('/snapshot')) return answer(200, snapshotOf(ROOM, old.members, old.log, since))
      if (path.endsWith('/messages')) {
        const said = entry(old.log.length + 1, 'message', options.me, (body as { body: string }).body)
        old.log.push(said)
        return answer(201, said)
      }
      if (path.endsWith('/me') && method === 'PUT') return answer(200, { ok: true })
      return answer(404, { error: 'no such route' })
    }
    if (url.origin === NEW || url.origin === EVIL) {
      if (path === '/host-proof') {
        const challenge = body as { roomId: string; origin: string; nonce: string }
        const proof = await hostProof(url.origin === NEW ? SECRET : 'not-the-secret-at-all-not-the-secret-at-all', challenge)
        return answer(200, { proof })
      }
      if (url.origin === EVIL) return answer(404, { error: 'nothing here' })
      if (path === '/join/nonce') return answer(200, { nonce: 'n'.repeat(32), expiresAt: 10 ** 9 })
      if (path === '/join') return answer(201, { status: 'admitted', room: { ...ROOM, hostLogin: 'dee' }, login: options.me, role: 'member', verified: true, token: 'new-token' })
      if (authorization !== 'Bearer new-token') return answer(401, { error: 'not in this room: join it again' })
      if (path === '/v1/me') return answer(200, { login: options.me, role: 'member', room: { ...ROOM, hostLogin: 'dee' } })
      if (path.endsWith('/snapshot')) return answer(200, snapshotOf({ ...ROOM, hostLogin: 'dee' }, old.members.slice(1), fresh.log, since))
      if (path.endsWith('/messages')) {
        fresh.posted.push((body as { body: string }).body)
        const said = entry(fresh.log.length + 1, 'message', options.me, (body as { body: string }).body)
        fresh.log.push(said)
        return answer(201, said)
      }
      if (path.endsWith('/me') && method === 'PUT') return answer(200, { ok: true })
      return answer(404, { error: 'no such route' })
    }
    // This machine's own room host, once it takes over.
    if (url.origin === LOCAL || url.origin === TUNNEL) {
      if (path === '/health') return answer(200, { ok: true })
      if (path === '/host/rooms/import') {
        const request = body as ImportRoomRequest
        imported.push(request)
        const last = request.log.at(-1)?.seq ?? 0
        const change: HostChangeData = { change: 'host', host: request.hostLogin, from: request.from, importedUpTo: last, reason: request.reason }
        fresh.log = [...request.log, entry(last + 1, 'system', null, `${request.hostLogin} hosts the room now (${request.reason})`, change)]
        return answer(201, { room: { ...ROOM, hostLogin: request.hostLogin }, token: 'local-token' })
      }
      if (path === '/host/origins') return answer(200, { ok: true })
      if (path === '/host/joins') return answer(200, [])
      if (path.endsWith('/coordinator')) return answer(200, { batch: null })
      if (path.endsWith('/snapshot')) return answer(200, snapshotOf({ ...ROOM, hostLogin: options.me }, old.members.slice(1), fresh.log, since))
      if (path.endsWith('/messages')) {
        fresh.posted.push((body as { body: string }).body)
        return answer(201, entry(fresh.log.length + 1, 'message', options.me, (body as { body: string }).body))
      }
      if (path.endsWith('/me') && method === 'PUT') return answer(200, { ok: true })
    }
    return answer(404, { error: 'no such route' })
  })

  const status = async ($: Engine) => (await $.command.run({ command: 'studio', args: 'status', ...TYPED })).text
  const run = async (ms: number) => {
    await clock.advance(ms)
    await clock.settle()
  }
  return { clock, run, git, old, fresh, imported, requests, toasts, logs, children, status }
}

// --- the host's side ------------------------------------------------------------------

// Ben hosts "frontend" on this machine (/room create), reachable at OLD; ana
// and dee are in it.
function hostWorld(on: On, options: { members: Member[] }) {
  const clock = mock.clock(on)
  mock.store(on, { identity: { login: 'ben', keyFile: 'C:\\Users\\ben\\.ssh\\id_ed25519', publicKey: 'ssh-ed25519 AAAA' } })
  mock.env(on, { USERPROFILE: 'C:\\Users\\ben' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.root', () => ({ value: 'C:/code/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  const git = fakeGit()
  fakeRun(on, ran => {
    const line = ran.argv.join(' ')
    if (line === 'gh api user --jq .login') return { stdout: 'ben\n' }
    if (line === 'gh api repos/acme/app') return { stdout: JSON.stringify({ permissions: { admin: true, push: true, pull: true }, owner: { login: 'ben', type: 'User' } }) }
    if (line === 'node --version') return { stdout: 'v24.1.0\n' }
    if (line === 'cloudflared --version') return { stdout: 'cloudflared version 2026.10.1\n' }
    if (ran.argv[0] === 'ssh-keygen') return { stdout: SIGNATURE }
    return git.answer(ran)
  })
  fakeSpawn(on, child => {
    if (child.argv[0] === 'node') {
      child.say(`{"event":"ready","port":4100,"hostKey":"${child.env?.STUDIO_HOST_KEY}"}\n`)
      return true
    }
    if (child.argv[0] === 'cloudflared') {
      child.say(`INF |  ${OLD}  |\n`, 'stderr')
      child.say('INF Registered tunnel connection connIndex=0\n', 'stderr')
      return true
    }
    return false
  })
  const calls: { method: string; url: string; body: unknown }[] = []
  const lookups = new Map<string, number>()
  const hosted: Room = { ...ROOM, hostLogin: 'ben' }
  const answer = (status: number, body: unknown) => ({ value: { status, ok: status < 400, headers: {}, text: JSON.stringify(body) } })
  on('http.fetch', async ($, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    calls.push({ method, url: e.url, body })
    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name') ?? ''
      const seen = (lookups.get(name) ?? 0) + 1
      lookups.set(name, seen)
      return answer(200, seen < 2 ? { Status: 3 } : { Status: 0, Answer: [{ name, type: 1, data: '104.16.0.1' }] })
    }
    if (url.origin === NEW) {
      if (url.pathname === '/host-proof') return answer(200, { proof: await hostProof(SECRET, body as { roomId: string; origin: string; nonce: string }) })
      if (url.pathname === '/join/nonce') return answer(200, { nonce: 'n'.repeat(32), expiresAt: 10 ** 9 })
      if (url.pathname === '/join') return answer(201, { status: 'admitted', room: { ...ROOM, hostLogin: 'dee' }, login: 'ben', role: 'owner', verified: true, token: 'ben-at-dee' })
      if (url.pathname.endsWith('/snapshot')) return answer(200, { room: { ...ROOM, hostLogin: 'dee' }, members: options.members, tasks: [], log: [], statusText: '', batch: null, state: null, cursor: 0 })
      return answer(404, { error: 'no such route' })
    }
    if (url.origin !== LOCAL && url.origin !== OLD) return answer(404, { error: 'no such route' })
    const path = url.pathname
    if (path === '/health') return answer(200, { ok: true })
    if (path === '/host/rooms' && method === 'POST') return answer(201, { room: hosted, token: 'ben-token', roomKey: null })
    if (path === '/host/origins' || path === '/host/close' || path.endsWith('/close')) return answer(200, { ok: true })
    if (path.endsWith('/handover')) return answer(201, entry(9, 'system', null, `ben hands the room over to ${(body as { to: string }).to}`))
    if (path === '/host/joins') return answer(200, [])
    if (path.endsWith('/coordinator')) return answer(200, { batch: null })
    if (path.endsWith('/snapshot')) {
      return answer(200, { room: hosted, members: options.members, tasks: [], log: [entry(1, 'system', 'ben', 'ben created the room and hosts it')], statusText: '', batch: null, state: null, cursor: 1, roomSecret: SECRET })
    }
    if (path.endsWith('/me')) return answer(200, { ok: true })
    return answer(404, { error: 'no such route' })
  })
  const run = async (ms: number) => {
    await clock.advance(ms)
    await clock.settle()
  }
  const command = async ($: Engine, args: string) => (await $.command.run({ command: 'room', args, ...TYPED })).text
  const hostCalls = () => calls.filter(call => call.url.startsWith(LOCAL) && /handover|close/.test(call.url)).map(call => `${call.method} ${new URL(call.url).pathname}`)
  return { clock, run, git, calls, hostCalls, toasts, command }
}

async function host($: Engine, world: ReturnType<typeof hostWorld>) {
  await $.session.start(START)
  expect(await world.command($, 'create "frontend"')).toMatch(/^frontend is open on this machine/)
  await world.run(0)
  await world.run(2000)
  await world.run(0)
}

const BEN = { ...member('ben', 1), role: 'owner' as const }

test('the host leaves: the room goes to the first successor who is here, and its directory entry is left for them', async ($, on) => {
  const world = hostWorld(on, { members: [BEN, member('ana', 2, false), member('dee', 3)] })
  await host($, world)
  expect(world.git.rooms().map(room => room.host)).toEqual(['ben'])

  expect(await world.command($, 'leave')).toBe('dee takes over hosting frontend; you are out of the room.')
  expect(world.calls.find(call => call.url.endsWith('/handover'))?.body).toEqual({ to: 'dee' })
  expect((await $.command.run({ command: 'studio', args: 'status', ...TYPED })).text).toBe('Not in a room.')
  // The room host keeps answering a moment, so every long-poll hears it.
  expect(world.hostCalls()).toEqual([`POST /host/rooms/${ROOM_ID}/handover`])
  await world.run(1500)
  expect(world.hostCalls()).toEqual([`POST /host/rooms/${ROOM_ID}/handover`, 'POST /host/close'])
  // Dee replaces the entry; ben's leaving does not remove it.
  expect(world.git.rooms().map(room => room.host)).toEqual(['ben'])
})

test('nobody here can take over: leaving says why, and --close closes the room for everyone', async ($, on) => {
  const world = hostWorld(on, { members: [BEN, member('ana', 2, false), { ...member('cem', 3), verified: false }, { ...member('dee', 4), canHost: false }] })
  await host($, world)

  expect(await world.command($, 'leave')).toBe(
    "Nobody else here can take over hosting frontend (ana is not online, cem is not verified, dee's machine cannot host). /room leave --close closes it for everyone.",
  )
  expect(world.hostCalls()).toEqual([])
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'if ben leaves, the room closes: nobody else here can host it' })).toBeUndefined()
  await ui.unmount()

  expect(await world.command($, 'leave --close')).toBe('Closed frontend for everyone.')
  expect(world.hostCalls()).toEqual([`POST /host/rooms/${ROOM_ID}/close`])
})

test('the pane warns when nobody but the host could host', async ($, on) => {
  const world = hostWorld(on, { members: [BEN, { ...member('dee', 2), canHost: false }] })
  await host($, world)
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'if ben leaves, the room closes: nobody else here can host it' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /dee \(cannot host, online\)/ })).toBeDefined()
  await ui.unmount()
})

test('quitting Claude Code while hosting hands the room over; a /clear does not', async ($, on) => {
  const world = hostWorld(on, { members: [BEN, member('ana', 2)] })
  await host($, world)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(world.hostCalls()).toEqual([])
  // It waits a moment (on the session's clock) for the members' long-polls to hear it.
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await world.run(400)
  await ending
  expect(world.calls.find(call => call.url.endsWith('/handover'))?.body).toEqual({ to: 'ana' })
  // The engine ends the room host with the session: nothing stops it here.
  expect(world.hostCalls()).toEqual([`POST /host/rooms/${ROOM_ID}/handover`])
})

test('a host whose machine slept through the room being taken over stands down and follows it', { timeoutMs: 15_000 }, async ($, on) => {
  const world = hostWorld(on, { members: [BEN, member('dee', 2)] })
  await host($, world)
  world.git.pushFromElsewhere(JSON.stringify({ version: 1, rooms: [listed('dee', NEW)] }))
  await world.run(60_000)
  await world.run(0)

  expect(world.toasts).toContain('Studio: frontend moved to dee while this machine was away: following it there')
  expect(world.calls.find(call => call.url === `${NEW}/join`)?.body).toMatchObject({ login: 'ben', origin: NEW })
  // Dee's entry stays.
  expect(world.git.rooms()).toEqual([listed('dee', NEW)])
  expect((await $.command.run({ command: 'studio', args: 'status', ...TYPED })).text).toMatch(/hosted by dee at https:\/\/new-host\.trycloudflare\.com/)
})

// --- members --------------------------------------------------------------------------

test('a planned handover: the follower finds the new host in the directory, checks its proof, and joins it on its signature', async ($, on) => {
  const { run, git, old, fresh, requests, toasts, status } = world(on, { me: 'cem', canHost: false })
  await $.session.start(START)
  await run(0)

  // Cem says something the old host takes; then ben hands over to dee.
  expect((await $.command.run({ command: 'room', args: 'say still on it', ...TYPED })).text).toBe('Posted.')
  const said = old.log.at(-1)?.seq ?? 0
  old.log.push(entry(said + 1, 'system', null, 'ben hands the room over to dee', { change: 'handover', from: 'ben', to: 'dee' }))
  await run(3000)
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /ben left: dee takes over hosting · waiting for dee to take over hosting/ })).toBeDefined()
  await ui.unmount()

  // Dee's mirror stopped before cem's message; its room is listed at NEW.
  const change: HostChangeData = { change: 'host', host: 'dee', from: 'ben', importedUpTo: said - 1, reason: 'ben left' }
  fresh.log = [...old.log.slice(0, said - 1), entry(said, 'system', null, 'dee hosts the room now (ben left)', change)]
  old.isDown = true
  git.pushFromElsewhere(JSON.stringify({ version: 1, rooms: [listed('dee', NEW)] }))
  await run(5000)
  await run(0)

  expect(await status($)).toMatch(/^you: {4}cem · member\nroom: {3}frontend · hosted by dee at https:\/\/new-host\.trycloudflare\.com/)
  expect(toasts).toContain('Studio: frontend is hosted by dee now')
  // The old token never went to the new address; a signature bound to it did.
  expect(requests.filter(request => request.url.startsWith(NEW) && request.authorization === 'Bearer old-token')).toEqual([])
  const join = requests.find(request => request.url === `${NEW}/join`)
  expect(join?.body).toMatchObject({ roomId: ROOM_ID, origin: NEW, login: 'cem', signature: SIGNATURE })
  // What the new host's log did not carry over is said again.
  expect(fresh.posted).toEqual(['still on it'])
  // Room mode and the secret came along.
  expect(await status($)).toMatch(/mode: {3}prompts stay local/)
})

test('a directory entry that cannot prove it hosts the room is not followed, and gets nothing', async ($, on) => {
  const { run, git, old, requests } = world(on, { me: 'cem', canHost: false })
  await $.session.start(START)
  await run(0)
  old.log.push(entry(3, 'system', null, 'ben hands the room over to dee', { change: 'handover', from: 'ben', to: 'dee' }))
  await run(3000)
  old.isDown = true
  git.pushFromElsewhere(JSON.stringify({ version: 1, rooms: [listed('dee', EVIL)] }))
  await run(5000)

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /lists the room at https:\/\/evil\.trycloudflare\.com, which could not prove it hosts it/ })).toBeDefined()
  await ui.unmount()
  const atEvil = requests.filter(request => request.url.startsWith(EVIL))
  expect(atEvil.map(request => request.url)).toEqual([`${EVIL}/host-proof`])
  expect(atEvil[0]?.authorization).toBeNull()
})

test('the host stops answering: after 30 s the first successor carries the room on from its mirror and claims the directory entry', { timeoutMs: 15_000 }, async ($, on) => {
  const { run, git, old, imported, toasts, status } = world(on, { me: 'ana', canHost: true })
  await $.session.start(START)
  await run(0)
  old.log.push(entry(3, 'message', 'dee', 'login form next?'))
  await run(3000)

  old.isDown = true
  // 3, 6, 12, 24, then the 30 s mark itself.
  for (const ms of [3000, 3000, 6000, 12000, 6000]) await run(ms)
  // The tunnel's name is in DNS on its second lookup.
  await run(2000)
  await run(2000)

  expect(imported).toHaveLength(1)
  const [request] = imported
  expect(request).toMatchObject({ hostLogin: 'ana', from: 'ben', hasLeft: false, reason: "ben's machine stopped answering", roomSecret: SECRET, roomKey: null })
  expect(request?.log.map(logged => logged.body)).toEqual(['ben created the room and hosts it', 'hello', 'login form next?'])
  expect(request?.state.coordinatorCursor).toBe(1)
  expect(request?.members.map(known => known.login)).toEqual(['ben', 'ana', 'cem', 'dee'])
  expect(request?.tasks.map(task => task.id)).toEqual(['t1'])
  expect(git.rooms()).toEqual([{ ...listed('ana', TUNNEL), updatedAt: expect.any(Number) }])
  expect(toasts).toContain('Studio: you host frontend now')
  expect(await status($)).toMatch(/hosted by ana at http:\/\/127\.0\.0\.1:4100/)
})

test('two candidates: the one whose claim finds the entry changed lets go and follows the winner', { timeoutMs: 15_000 }, async ($, on) => {
  let isRaced = false
  const raced = world(on, {
    me: 'ana',
    canHost: true,
    beforePush: () => {
      // Dee published first, between ana's read and her push.
      if (isRaced) return
      isRaced = true
      raced.git.pushFromElsewhere(JSON.stringify({ version: 1, rooms: [listed('dee', NEW)] }))
      raced.fresh.log = [...raced.old.log, entry(3, 'system', null, 'dee hosts the room now', { change: 'host', host: 'dee', from: 'ben', importedUpTo: 2, reason: "ben's machine stopped answering" })]
    },
  })
  const { run, old, toasts, requests, status } = raced
  await $.session.start(START)
  await run(0)
  old.isDown = true
  for (const ms of [3000, 3000, 6000, 12000, 6000, 2000, 2000]) await run(ms)
  await run(5000)

  expect(toasts).toContain('Studio: someone else took over hosting first: following the room there')
  expect(raced.git.rooms()).toEqual([listed('dee', NEW)])
  expect(requests.some(request => request.url === `${NEW}/join`)).toBe(true)
  expect(await status($)).toMatch(/hosted by dee at https:\/\/new-host\.trycloudflare\.com/)
})

test('a blip: the old host answers again before anyone took over, and nothing moves', { timeoutMs: 15_000 }, async ($, on) => {
  const { run, old, imported, status } = world(on, { me: 'cem', canHost: false })
  await $.session.start(START)
  await run(0)
  old.isDown = true
  for (const ms of [3000, 3000, 6000, 12000, 6000]) await run(ms)
  old.isDown = false
  await run(5000)
  await run(3000)
  expect(imported).toEqual([])
  expect(await status($)).toMatch(/hosted by ben at https:\/\/old-host\.trycloudflare\.com/)
  expect(await status($)).toMatch(/sync: {3}ok/)
})
