// Hosting a room from the mod (hooks/hosting.ts, providers.ts, directory.ts)
// on a fake machine: the room host and cloudflared are fake children, DNS
// over HTTPS and the room host's routes fake URLs, git a fake remote.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { parseInvite } from '../protocol/join'
import { unseal } from '../protocol/seal'
import type { Room, RoomSnapshot } from '../protocol/types'
import { PANE, START, TYPED, fakeGit, fakeNet, fakeRun, fakeSpawn, ok } from './fakes'
import type { Call, FakeChild, GitRemote } from './fakes'

const ROOM_ID = '5f0c2a5e-1d2b-4c3a-9e8f-0123456789ab'
const LOCAL = 'http://127.0.0.1:4100'
const TUNNELS = ['https://quiet-river.trycloudflare.com', 'https://loud-lake.trycloudflare.com']
const ROOM_KEY = 'k'.repeat(43)
const LAN = 'http://192.168.1.5:4200'

function roomOf(visibility: 'open' | 'private'): Room {
  return { id: ROOM_ID, name: 'frontend', visibility, repoUrl: 'https://github.com/acme/app', hostLogin: 'ben', createdAt: 1 }
}

type Machine = {
  visibility?: 'open' | 'private'
  beforePush?: (remote: GitRemote) => void
  // `node --version`'s answer; null: Node is not installed.
  node?: string | null
  cloudflared?: boolean
  // Files that do not exist on this machine (a path containing one of these).
  missing?: string[]
  env?: Record<string, string>
}

function machine(on: On, options: Machine = {}) {
  const clock = mock.clock(on)
  mock.store(on, { identity: { login: 'ben', keyFile: null, publicKey: null } })
  mock.env(on, options.env ?? { USERPROFILE: 'C:\\Users\\ben' })
  on('fs.exists', ($, e) => ({ value: !(options.missing ?? []).some(part => e.path.includes(part)) }))
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

  const git = fakeGit({ beforePush: options.beforePush })
  const runs = fakeRun(on, ran => {
    const line = ran.argv.join(' ')
    if (line === 'gh api user --jq .login') return { stdout: 'Ben\n' }
    if (line === 'gh api repos/acme/app') {
      return { stdout: JSON.stringify({ permissions: { admin: true, push: true, pull: true }, owner: { login: 'acme', type: 'Organization' } }) }
    }
    if (line === 'gh api user/memberships/orgs/acme') return { stdout: '{"state":"active","role":"admin"}' }
    if (line === 'node --version' && options.node !== null) return { stdout: `${options.node ?? 'v24.1.0'}\n` }
    if (line === 'cloudflared --version' && options.cloudflared !== false) return { stdout: 'cloudflared version 2026.10.1\n' }
    return git.answer(ran)
  })

  // The room host prints its ready line; each cloudflared start gets the next name.
  let tunnels = 0
  const children = fakeSpawn(on, child => {
    if (child.argv[0] === 'node' && child.argv[1]?.endsWith('index.ts')) {
      child.say(`{"event":"ready","port":4100,"hostKey":"${child.env?.STUDIO_HOST_KEY}"}\n`)
      return true
    }
    if (child.argv[1]?.endsWith('relay.ts')) {
      child.say(`{"event":"relay","address":"${LAN}"}\n`)
      return true
    }
    if (child.argv[0] === 'cloudflared') {
      const address = TUNNELS[tunnels++] ?? 'https://none.trycloudflare.com'
      child.say('INF Requesting new quick Tunnel on trycloudflare.com...\n', 'stderr')
      child.say(`INF |  ${address}  |\n`, 'stderr')
      child.say('INF Registered tunnel connection connIndex=0 location=fra08\n', 'stderr')
      return true
    }
    return false
  })

  // Public DNS has a tunnel's name from its second lookup on.
  const lookups = new Map<string, number>()
  const room = roomOf(options.visibility ?? 'open')
  const snapshot: RoomSnapshot = { room, members: [], tasks: [], log: [], statusText: '', cursor: 0 }
  const calls = fakeNet(on, call => {
    const url = new URL(call.url)
    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name') ?? ''
      const seen = (lookups.get(name) ?? 0) + 1
      lookups.set(name, seen)
      return ok(seen < 2 ? { Status: 3 } : { Status: 0, Answer: [{ name, type: 1, data: '104.16.0.1' }] })
    }
    if (url.pathname === '/health' && (TUNNELS.includes(url.origin) || url.origin === LAN)) return ok({ ok: true })
    if (url.origin !== LOCAL) return undefined
    if (call.method === 'POST' && url.pathname === '/host/rooms') {
      return ok({ room, token: 'ben-token', roomKey: room.visibility === 'private' ? ROOM_KEY : null }, 201)
    }
    if (call.method === 'PUT' && url.pathname === '/host/origins') return ok({ ok: true })
    if (url.pathname === '/host/joins') return ok([])
    if (url.pathname === `/v1/rooms/${ROOM_ID}/snapshot`) return ok(snapshot)
    if (url.pathname === `/v1/rooms/${ROOM_ID}/leave`) return ok({ ok: true })
    return undefined
  })
  return { clock, logs, toasts, git, runs, children, calls }
}

const node = (children: FakeChild[]) => children.filter(child => child.argv[0] === 'node')
const tunnel = (children: FakeChild[]) => children.filter(child => child.argv[0] === 'cloudflared')
const origins = (calls: Call[]) => calls.filter(call => call.method === 'PUT' && call.url === `${LOCAL}/host/origins`).map(call => call.body)

async function command($: Engine, command: 'room' | 'studio', args: string) {
  return (await $.command.run({ command, args, ...TYPED })).text
}

// From /room create to the invite: the DNS wait takes one lookup more.
async function createAndExpose($: Engine, clock: ReturnType<typeof mock.clock>, args = '"frontend"') {
  await $.session.start(START)
  const text = await command($, 'room', `create ${args}`)
  await clock.settle()
  await clock.advance(2000)
  await clock.settle()
  return text
}

test('/room create: room host, then cloudflared, DNS, origins, the invite and the directory', async ($, on) => {
  const { clock, logs, git, runs, children, calls } = machine(on)
  const text = await createAndExpose($, clock)
  expect(text).toMatch(/^frontend is open on this machine for acme\/app\./)

  // The room host: loopback port 0, a data folder of its own, a host key in its environment.
  const [roomHost] = node(children)
  expect(roomHost?.argv.slice(2, 4)).toEqual(['--port', '0'])
  expect(roomHost?.argv[1]).toMatch(/[\\/]room-host[\\/]src[\\/]index\.ts$/)
  expect(roomHost?.argv[5]).toMatch(/^C:\\Users\\ben\\\.claude\\studio\\room-hosts\\[A-Za-z0-9_-]{12}$/)
  expect(roomHost?.env?.STUDIO_HOST_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/)

  // The host person joins as owner: an admin of the org that owns the repo.
  const create = calls.find(call => call.url === `${LOCAL}/host/rooms`)
  expect(create?.body).toEqual({ name: 'frontend', visibility: 'open', repoUrl: 'https://github.com/acme/app', login: 'ben', role: 'owner' })
  expect(create?.authorization).toBe(`Bearer ${roomHost?.env?.STUDIO_HOST_KEY}`)

  // Nothing looks the tunnel's name up before public DNS has it.
  expect(tunnel(children)[0]?.argv).toEqual(['cloudflared', 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:4100'])
  const firstUse = calls.findIndex(call => call.url.startsWith(TUNNELS[0] ?? ''))
  const dns = calls.map((call, at) => ({ call, at })).filter(({ call }) => call.url.includes('dns-query'))
  expect(dns.length).toBe(2)
  expect(firstUse).toBeGreaterThan(dns[1]?.at ?? Infinity)

  expect(origins(calls)).toEqual([{ origins: [TUNNELS[0]] }])
  const invite = parseInvite(logs.find(line => line.includes('studio:join')) ?? '')
  expect(invite).toEqual({ roomId: ROOM_ID, address: TUNNELS[0], roomKey: null })
  // No install line yet: the plugin is not published (hooks/invite.ts MARKETPLACE).
  expect(await command($, 'room', 'invite')).toBe(
    [
      'Invite link:',
      `studio:join?room=${ROOM_ID}&at=${encodeURIComponent(TUNNELS[0] ?? '')}`,
      '',
      'Whoever gets it runs /room join with it. The first time, that also links their GitHub login and an SSH key GitHub lists for it.',
    ].join('\n'),
  )

  // The directory: one commit on a new orphan branch, by the host.
  expect(git.remote.pushes.map(push => push.parent)).toEqual([null])
  expect(git.remote.pushes[0]?.env.GIT_AUTHOR_NAME).toBe('studio (ben)')
  expect(git.rooms()).toEqual([{ id: ROOM_ID, visibility: 'open', name: 'frontend', host: 'ben', address: TUNNELS[0], updatedAt: 2000 }])
  expect(runs.some(ran => ran.argv.includes('checkout') || ran.argv.includes('worktree'))).toBe(false)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'studio', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: `reachable at ${TUNNELS[0]} (cloudflared)` })).toBeDefined()
    await ui.unmount()
  }
})

test('a private room: its entry sealed with the room key, its link kept from the model', async ($, on) => {
  const { clock, logs, git } = machine(on, { visibility: 'private' })
  await createAndExpose($, clock, '"frontend" --private')

  const [entry] = git.rooms()
  expect(entry?.visibility).toBe('private')
  expect(JSON.stringify(entry)).not.toMatch(/frontend|ben|trycloudflare/)
  expect(JSON.parse((await unseal(ROOM_KEY, ROOM_ID, entry?.sealed ?? '')) ?? '{}')).toEqual({ name: 'frontend', host: 'ben', address: TUNNELS[0] })

  const text = await command($, 'room', 'invite')
  expect(text).not.toContain(ROOM_KEY)
  expect(text).toBe("The invite is printed above, not shown to the model: the link carries the private room's key.")
  expect(logs.at(-1)).toContain(`key=${ROOM_KEY}`)
  expect(logs.at(-1)).toContain("The link carries the private room's key: share it like a password.")
})

test('a push that lost a race is replayed on the other host\'s entry', async ($, on) => {
  let elsewhere: string | null = null
  const other = { id: '6a1d3b6f-2e3c-4d4b-8f90-123456789abc', visibility: 'open', name: 'backend', host: 'ana', address: 'https://ana.trycloudflare.com', updatedAt: 1 }
  const { clock, git } = machine(on, {
    beforePush: () => {
      // Ana's host pushes its entry between our read and our push.
      if (elsewhere !== null) return
      elsewhere = git.pushFromElsewhere(JSON.stringify({ version: 1, rooms: [other] }))
    },
  })
  await createAndExpose($, clock)
  await clock.advance(2000)
  await clock.settle()

  expect(git.remote.pushes.length).toBe(1)
  expect(git.remote.pushes[0]?.parent).toBe(elsewhere)
  expect(git.rooms().map(room => room.id).sort()).toEqual([ROOM_ID, other.id].sort())
})

test('create drops the host\'s own entries that no longer answer, and only those', async ($, on) => {
  const id = (n: number) => `7777777${n}-7777-4777-8777-777777777777`
  const old = (n: number, host: string, address: string) => ({ id: id(n), visibility: 'open', name: `old ${n}`, host, address, updatedAt: 1 })
  const { clock, git, calls } = machine(on)
  git.pushFromElsewhere(JSON.stringify({
    version: 1,
    rooms: [
      old(1, 'ben', 'https://gone.trycloudflare.com'),
      old(2, 'Ben', TUNNELS[1] ?? ''),
      old(3, 'ana', 'https://ana-gone.trycloudflare.com'),
    ],
  }))
  await createAndExpose($, clock)

  expect(git.rooms().map(room => room.id).sort()).toEqual([ROOM_ID, id(2), id(3)].sort())
  // Only ben's older entries are asked, each once.
  const asked = calls.filter(call => call.url.endsWith('/health') && call.url !== `${TUNNELS[0]}/health`).map(call => new URL(call.url).origin)
  expect(asked.sort()).toEqual(['https://gone.trycloudflare.com', TUNNELS[1]].sort())
})

test('the room host dies: one restart on its port, data and key; the second death loses the room', async ($, on) => {
  const { clock, toasts, git, children, calls } = machine(on)
  await createAndExpose($, clock)
  const [first] = node(children)

  first?.say('boom\n', 'stderr')
  first?.exit(1)
  await clock.settle()
  const [, second] = node(children)
  expect(second?.argv.slice(2)).toEqual(['--port', '4100', '--data', first?.argv[5] ?? ''])
  expect(second?.env?.STUDIO_HOST_KEY).toBe(first?.env?.STUDIO_HOST_KEY)
  expect(origins(calls)).toEqual([{ origins: [TUNNELS[0]] }, { origins: [TUNNELS[0]] }])
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'the room host stopped and was restarted' })).toBeDefined()
  await ui.unmount()

  second?.exit(1)
  await clock.settle()
  expect(node(children).length).toBe(2)
  expect(toasts).toContain('Studio: room lost: the room host stopped (exit 1)')
  expect(await command($, 'studio', 'status')).toBe('Not in a room.')
  // The pane's address line is the reason, once.
  const lost = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await lost.find({ type: 'Text', text: 'room lost: the room host stopped (exit 1)' })).toBeDefined()
  await lost.unmount()
  // Its directory entry goes with it.
  expect(git.rooms()).toEqual([])
})

test('the tunnel dies: one restart at a new address, published and announced', async ($, on) => {
  const { clock, logs, git, children, calls } = machine(on)
  await createAndExpose($, clock)

  tunnel(children)[0]?.exit(1)
  await clock.settle()
  await clock.advance(2000)
  await clock.settle()

  expect(tunnel(children).length).toBe(2)
  expect(origins(calls).at(-1)).toEqual({ origins: [TUNNELS[1]] })
  expect(logs.at(-1)).toContain(`at=${encodeURIComponent(TUNNELS[1] ?? '')}`)
  expect(git.rooms().map(room => room.address)).toEqual([TUNNELS[1]])
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /new address: members join again/ })).toBeDefined()
  await ui.unmount()
})

test('the last one out: the room host exits, hosting ends, the entry goes', async ($, on) => {
  const { clock, git, children } = machine(on)
  await createAndExpose($, clock)

  expect(await command($, 'room', 'leave')).toBe('Left the room.')
  const [roomHost] = node(children)
  roomHost?.say('{"event":"room-closed","roomId":"' + ROOM_ID + '"}\n{"event":"exiting"}\n')
  roomHost?.exit(0)
  await clock.settle()

  expect(node(children).length).toBe(1)
  expect(git.rooms()).toEqual([])
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Not in a room/ })).toBeDefined()
  await ui.unmount()
})

test('a session that hosted, after a reload: the room is gone with its room host', async ($, on) => {
  const toasts: string[] = []
  mock.clock(on)
  mock.store(on, { room: { hostUrl: LOCAL, roomId: ROOM_ID, token: 't', login: 'ben', isHost: true } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/code/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start(START)
  expect(toasts[0]).toMatch(/the room you hosted ended with its room host/)
  expect(await command($, 'studio', 'status')).toBe('Not in a room.')
})

// --- the host check -----------------------------------------------------------

test('host check: no Node and no installed dependencies are named together, and nothing starts', async ($, on) => {
  const { children, calls } = machine(on, { node: null, missing: ['node_modules'] })
  await $.session.start(START)

  const text = await command($, 'room', 'create "frontend"')
  expect(text).toMatch(/^room create: this machine cannot host a room yet:\n- Node\.js is not installed, and the room host runs on Node 24 or newer\. Install it: winget install OpenJS\.NodeJS\n- The room host's dependencies are not installed\. Run `pnpm install` in \S+$/)
  expect(text).not.toMatch(/\.\./)
  expect(children).toEqual([])
  expect(calls).toEqual([])
  expect(await command($, 'studio', 'status')).toBe('Not in a room.')
})

test('host check: an older Node says which one it found', async ($, on) => {
  const { children } = machine(on, { node: 'v22.3.0' })
  await $.session.start(START)

  const text = await command($, 'room', 'create "frontend"')
  expect(text).toContain('- Node 22.3.0 is installed, and the room host needs Node 24 or newer. Install it: winget install OpenJS.NodeJS')
  expect(children).toEqual([])
})

test('host check: the room host not beside the plugin (a plugin installed alone)', async ($, on) => {
  const { children } = machine(on, { missing: ['index.ts'] })
  await $.session.start(START)

  const text = await command($, 'room', 'create "frontend"')
  expect(text).toMatch(/- The room host is not where the plugin expects it \(\S*room-host\S*index\.ts\)\. Studio's repo has to be installed whole, next to plugin\/\.$/)
  expect(text).not.toContain('pnpm install')
  expect(children).toEqual([])
})

test('host check: --via names what its provider needs, in the install line of the machine', async ($, on) => {
  const windows = machine(on, { cloudflared: false })
  await $.session.start(START)
  expect(await command($, 'room', 'create "a" --via cloudflared')).toContain('- cloudflared is not installed (--via cloudflared). Install it: winget install --id Cloudflare.cloudflared')
  expect(await command($, 'room', 'create "a" --via funnel')).toContain('- Tailscale is not running on this machine (--via funnel). Start it, or install it: https://tailscale.com/download')
  expect(windows.children).toEqual([])
})

test('host check: macOS and Linux get their own install lines', async ($, on) => {
  machine(on, { cloudflared: false, node: 'v20.0.0', env: { HOME: '/Users/ben' } })
  await $.session.start(START)
  const text = await command($, 'room', 'create "a" --via cloudflared')
  expect(text).toContain('Install it: brew install node')
  expect(text).toContain('Install it: brew install cloudflared')
})

test('host check: Linux is told where to get them', async ($, on) => {
  machine(on, { cloudflared: false, node: null, env: { HOME: '/home/ben' } })
  await $.session.start(START)
  const text = await command($, 'room', 'create "a" --via cloudflared')
  expect(text).toContain('Install it: install Node 24 from https://nodejs.org/en/download (or: nvm install 24)')
  expect(text).toContain('Install it: install cloudflared from https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/')
})

test('host check: with neither Tailscale nor cloudflared the room opens on the LAN and says what to install', async ($, on) => {
  const { clock, logs, children } = machine(on, { cloudflared: false })
  const text = await createAndExpose($, clock)

  expect(text).toContain('Only machines on this network can reach the room: neither Tailscale (running) nor cloudflared was found.')
  expect(text).toContain('install cloudflared (winget install --id Cloudflare.cloudflared) and /room create again.')
  expect(children.filter(child => child.argv[1]?.endsWith('relay.ts')).length).toBe(1)
  expect(parseInvite(logs.find(line => line.includes('studio:join')) ?? '')?.address).toBe(LAN)
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /LAN only, no TLS/ })).toBeDefined()
  await ui.unmount()
})

// --- the pane's address line and the invite's notes -----------------------------

test('the pane says how far the address has got, then where the room is reachable', async ($, on) => {
  const { clock } = machine(on)
  await $.session.start(START)
  await command($, 'room', 'create "frontend"')

  // The tunnel is up but its name is not in DNS yet: the wait is named.
  const waiting = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await waiting.find({ type: 'Text', text: 'starting the tunnel (cloudflared) and waiting for its name to resolve: up to a minute…' })).toBeDefined()
  await waiting.unmount()

  await clock.settle()
  await clock.advance(2000)
  await clock.settle()
  const up = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await up.find({ type: 'Text', text: `reachable at ${TUNNELS[0]} (cloudflared)` })).toBeDefined()
  expect(await up.find({ type: 'Text', text: /starting the tunnel/ })).toBeUndefined()
  await up.unmount()
})

test('/room invite on the LAN carries the provider\'s caveat', async ($, on) => {
  const { clock } = machine(on, { cloudflared: false })
  await createAndExpose($, clock)

  const text = await command($, 'room', 'invite')
  expect(text).toContain(`studio:join?room=${ROOM_ID}&at=${encodeURIComponent(LAN)}`)
  expect(text).toMatch(/\nNote: LAN only, no TLS: joiners must be on this network/)
})
