// Joining by invite link (hooks/joining.ts, identity.ts) against a fake room
// host, and the host person letting someone in from the pane.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { inviteLink, joinMessage } from '../protocol/join'
import type { JoinAdmitted, PendingJoin, Room, RoomSnapshot } from '../protocol/types'
import { PANE, START, TYPED, fakeNet, fakeRun, ok } from './fakes'
import type { Call, Reply } from './fakes'

const ROOM_ID = '5f0c2a5e-1d2b-4c3a-9e8f-0123456789ab'
const HOST = 'https://quiet-river.trycloudflare.com'
const KEY_FILE = 'C:\\Users\\ana\\.ssh\\id_ed25519'
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBfakekey'
const SIGNATURE = '-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n'
const ROOM: Room = { id: ROOM_ID, name: 'frontend', visibility: 'open', repoUrl: 'https://github.com/acme/app', hostLogin: 'ben', createdAt: 1 }
const SNAPSHOT: RoomSnapshot = { room: ROOM, members: [], tasks: [], log: [], statusText: '', cursor: 0 }
const ADMITTED: JoinAdmitted = { status: 'admitted', room: ROOM, login: 'ana', role: 'member', verified: true, token: 'ana-token' }

const LINK = inviteLink({ roomId: ROOM_ID, address: HOST, roomKey: null })

type Host = (call: Call, path: string) => Reply | undefined

const IDENTITY = { identity: { login: 'ana', keyFile: KEY_FILE, publicKey: PUBLIC_KEY } }
const NOT_FOUND = { fail: 'ENOTFOUND: getaddrinfo ENOTFOUND quiet-river.trycloudflare.com' }

// `resolves`: whether the host's name resolves (a fresh quick tunnel's does not, at first).
function joiner(on: On, host: Host, options: { store?: Record<string, unknown>; resolves?: () => boolean } = {}) {
  const { store = IDENTITY, resolves = () => true } = options
  const clock = mock.clock(on)
  mock.store(on, store)
  mock.env(on, { USERPROFILE: 'C:\\Users\\ana' })
  const toasts: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/code/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const runs = fakeRun(on, ran => {
    if (ran.argv.slice(0, 4).join(' ') === 'ssh-keygen -Y sign -n') return { stdout: SIGNATURE }
    return undefined
  })
  const calls = fakeNet(on, call => {
    const url = new URL(call.url)
    if (url.origin !== HOST) return undefined
    if (!resolves()) return NOT_FOUND
    if (url.pathname === '/join/nonce') return ok({ nonce: `nonce${calls.length}`, expiresAt: 0 })
    if (url.pathname === '/v1/me') return ok({ login: 'ana', role: 'member', room: ROOM })
    if (url.pathname === `/v1/rooms/${ROOM_ID}/snapshot`) return ok(SNAPSHOT)
    return host(call, url.pathname)
  })
  return { clock, toasts, runs, calls }
}

const run = async ($: Engine, command: 'room' | 'studio', args: string) => (await $.command.run({ command, args, ...TYPED })).text

test('/room join signs the host\'s nonce with the linked key and enters the room', async ($, on) => {
  const { clock, runs, calls } = joiner(on, (call, path) => (path === '/join' ? ok(ADMITTED, 201) : undefined))
  await $.session.start(START)
  expect(await run($, 'room', `join ${LINK}`)).toBe('Joined frontend, hosted by ben.')
  await clock.settle()

  const nonce = calls.find(call => call.url === `${HOST}/join/nonce`)
  expect(nonce?.body).toEqual({ roomId: ROOM_ID })
  const signed = runs.find(ran => ran.argv[0] === 'ssh-keygen')
  expect(signed?.argv).toEqual(['ssh-keygen', '-Y', 'sign', '-n', 'studio-join', '-f', KEY_FILE])
  expect(signed?.stdin).toBe(joinMessage({ roomId: ROOM_ID, origin: HOST, login: 'ana', nonce: 'nonce1' }))
  const join = calls.find(call => call.url === `${HOST}/join`)
  expect(join?.body).toEqual({ roomId: ROOM_ID, origin: HOST, login: 'ana', nonce: 'nonce1', signature: SIGNATURE })

  expect(calls).toContainEqual({ method: 'GET', url: `${HOST}/v1/rooms/${ROOM_ID}/snapshot?since=0`, body: undefined, authorization: 'Bearer ana-token' })
  expect(await run($, 'studio', 'status')).toMatch(/^you: {4}ana · member\nroom: {3}frontend · hosted by ben at https:\/\/quiet-river/)
})

test('a private room\'s key goes with the join; without a key the join says why', async ($, on) => {
  const { calls } = joiner(
    on,
    (call, path) => (path === '/join' ? ok({ ...ADMITTED, room: { ...ROOM, visibility: 'private' } }, 201) : undefined),
    { store: { identity: { login: 'ana', keyFile: null, publicKey: null, noKey: 'none of the keys fit' } } },
  )
  await $.session.start(START)
  const key = 'k'.repeat(43)
  await run($, 'room', `join ${inviteLink({ roomId: ROOM_ID, address: HOST, roomKey: key })}`)
  const join = calls.find(call => call.url === `${HOST}/join`)
  // The host reads why, without this machine's paths.
  expect(join?.body).toEqual({
    roomId: ROOM_ID, origin: HOST, login: 'ana', nonce: 'nonce1', signature: null, noProof: 'no SSH key GitHub lists for me is usable here', roomKey: key,
  })
})

test('a name that does not resolve yet: tried again every 5 s, then joined', async ($, on) => {
  let isResolving = false
  const { clock, toasts } = joiner(on, (call, path) => (path === '/join' ? ok(ADMITTED, 201) : undefined), { resolves: () => isResolving })
  await $.session.start(START)
  expect(await run($, 'room', `join ${LINK}`)).toMatch(/does not resolve yet .*trying again for 90 s/)

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /waiting for the address to resolve/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(5000)
  expect(await run($, 'studio', 'status')).toBe('Not in a room.')
  isResolving = true
  await clock.advance(5000)
  expect(toasts).toContain('Studio: Joined frontend, hosted by ben.')
  expect(await run($, 'studio', 'status')).toMatch(/^you: {4}ana/)
})

test('a name that never resolves: given up after 90 s', async ($, on) => {
  const { clock, toasts } = joiner(on, () => undefined, { resolves: () => false })
  await $.session.start(START)
  await run($, 'room', `join ${LINK}`)
  await clock.advance(95_000)
  expect(toasts).toContain(`Studio: could not join: ${HOST} did not resolve in 90 s`)
})

test('without proof the join waits for the host person; the ticket brings the token', async ($, on) => {
  let decision: Reply = ok({ status: 'pending', reason: 'no SSH proof (no key)' })
  const { clock, toasts, calls } = joiner(on, (call, path) => {
    if (path === '/join') return ok({ status: 'pending', ticket: 'ticket-1', reason: 'no SSH proof (no key)' }, 202)
    if (path === '/join/tickets/ticket-1') return decision
    return undefined
  })
  await $.session.start(START)
  expect(await run($, 'room', `join ${LINK}`)).toBe('The host decides whether you get in: no SSH proof (no key). The room pane shows when they do.')

  await clock.advance(2000)
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /waiting for the host to let you in/ })).toBeDefined()
  await ui.unmount()

  decision = ok({ ...ADMITTED, verified: false })
  await clock.advance(2000)
  expect(calls.filter(call => call.url === `${HOST}/join/tickets/ticket-1`).length).toBe(2)
  expect(toasts).toContain('Studio: Joined frontend, hosted by ben (let in by hand: unverified).')
  expect(await run($, 'studio', 'status')).toMatch(/^you: {4}ana/)
})

test('refused by the host: the pane says so', async ($, on) => {
  const { clock, toasts } = joiner(on, (call, path) => {
    if (path === '/join') return ok({ status: 'pending', ticket: 'ticket-1', reason: 'r' }, 202)
    if (path === '/join/tickets/ticket-1') return ok({ status: 'refused', reason: 'the host did not let you in' })
    return undefined
  })
  await $.session.start(START)
  await run($, 'room', `join ${LINK}`)
  await clock.advance(2000)
  expect(toasts).toContain('Studio: could not join: the host did not let you in')
})

test('a read-only collaborator hears why', async ($, on) => {
  joiner(on, (call, path) =>
    path === '/join' ? { status: 403, body: { error: 'rea has read access to acme/app; rooms need write access' } } : undefined)
  await $.session.start(START)
  expect(await run($, 'room', `join ${LINK}`)).toBe('room join: rea has read access to acme/app; rooms need write access')
  expect(await run($, 'room', 'join not-a-link')).toMatch(/^Usage: \/room join/)
})

// --- /studio login ------------------------------------------------------------

function keys(on: On, options: { agent?: string; hasPassphrase?: boolean; github?: string }) {
  mock.store(on, {})
  mock.env(on, { USERPROFILE: 'C:\\Users\\ana' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/code/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  fakeNet(on, call => (call.url === 'https://github.com/ana.keys' ? ok(options.github ?? `${PUBLIC_KEY}\n`) : undefined))
  on('fs.list', ($, e) => ({ value: e.path === 'C:\\Users\\ana\\.ssh' ? [{ name: 'id_ed25519.pub', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] : [] }))
  on('fs.read', ($, e) => (e.path === `${KEY_FILE}.pub` ? { value: `${PUBLIC_KEY} ana@laptop\n` } : { deny: 'ENOENT' }))
  on('fs.exists', ($, e) => ({ value: e.path === KEY_FILE }))
  return fakeRun(on, ran => {
    const line = ran.argv.join(' ')
    if (line === 'gh api user --jq .login') return { stdout: 'ana\n' }
    if (line === 'ssh-add -L') return options.agent === undefined ? { exitCode: 1, stdout: 'The agent has no identities.\n' } : { stdout: options.agent }
    if (line === `ssh-keygen -y -P  -f ${KEY_FILE}`) {
      return options.hasPassphrase === true ? { exitCode: 255, stderr: 'incorrect passphrase' } : { stdout: PUBLIC_KEY }
    }
    return undefined
  })
}

test('/studio login: the gh login, and a key file GitHub lists that needs no passphrase', async ($, on) => {
  keys(on, {})
  await $.session.start(START)
  expect(await run($, 'studio', 'login')).toBe(`Linked ana: joins are signed with ${KEY_FILE}, a key github.com/ana.keys lists.`)
})

test('/studio login: a key the agent holds is signed through its .pub file', async ($, on) => {
  keys(on, { agent: `${PUBLIC_KEY} ana@laptop\n`, hasPassphrase: true })
  await $.session.start(START)
  expect(await run($, 'studio', 'login')).toBe(`Linked ana: joins are signed with ${KEY_FILE}.pub, a key github.com/ana.keys lists.`)
})

test('/studio login: a key with a passphrase, or none GitHub lists, says what to do', async ($, on) => {
  keys(on, { hasPassphrase: true })
  await $.session.start(START)
  expect(await run($, 'studio', 'login')).toBe(
    `Linked ana, without a key: ${KEY_FILE} has a passphrase: run ssh-add ${KEY_FILE}, then /studio login again.\nJoins then wait for the host person to let you in by hand.`,
  )
})

test('/studio login: none of the keys is on GitHub', async ($, on) => {
  keys(on, { github: 'ssh-ed25519 AAAAsomeoneelse\n' })
  await $.session.start(START)
  expect(await run($, 'studio', 'login')).toMatch(/without a key: none of this machine's SSH keys is one github\.com\/ana\.keys lists/)
})

// --- the host person lets someone in ---------------------------------------------

test('the host\'s pane lists who waits, and Let in admits them', async ($, on) => {
  const waiting: PendingJoin[] = [{ id: 'j1', roomId: ROOM_ID, login: 'cem', verified: false, reason: 'no SSH proof (no key)', at: 1 }]
  const clock = mock.clock(on)
  mock.store(on, { identity: { login: 'ben', keyFile: null, publicKey: null } })
  mock.env(on, { USERPROFILE: 'C:\\Users\\ben' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/code/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  // Node 24 and the room host's files are there (the host check); nothing else is installed.
  fakeRun(on, ran => (ran.argv.join(' ') === 'node --version' ? { stdout: 'v24.1.0\n' } : undefined))
  on('fs.exists', () => ({ value: true }))
  on('process.spawn', async function* ($, e) {
    yield { stream: 'stdout' as const, text: '{"event":"ready","port":4100,"hostKey":"x"}\n' }
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })
  const calls = fakeNet(on, call => {
    if (call.url === 'http://127.0.0.1:4100/host/rooms') return ok({ room: ROOM, token: 't', roomKey: null }, 201)
    if (call.url === 'http://127.0.0.1:4100/host/joins') return ok(waiting)
    if (call.url === 'http://127.0.0.1:4100/host/joins/j1/admit') {
      waiting.length = 0
      return ok({ ok: true })
    }
    if (call.url.startsWith(`http://127.0.0.1:4100/v1/rooms/${ROOM_ID}/snapshot`)) return ok(SNAPSHOT)
    return undefined
  })
  await $.session.start(START)
  await run($, 'room', 'create "frontend" --via lan')
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'studio', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: 'cem wants in (unverified: no SSH proof (no key))' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  await ui.press({ key: 'admit:j1' })
  expect(calls.find(call => call.url.endsWith('/host/joins/j1/admit'))?.body).toEqual({ role: 'member' })
  expect(await ui.find({ key: 'admit:j1' })).toBeUndefined()
  await ui.unmount()
})
