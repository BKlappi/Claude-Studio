// Hosting a room from this session (PLAN.md D14, D15, D16): the room host
// runs as this session's child, an address provider makes it reachable, and
// a supervisor restarts either once when it dies; a second death loses the
// room.
//
//   /room create
//     → node room-host/src/index.ts --port 0 --data <folder>   (ready line)
//     → POST /host/rooms: the room, with this person as its first member
//     → in the background: the address provider, its address set as the
//       room host's origin, the invite link printed once the address
//       answers, the directory entry (D17)
//
// Restarting the room host reuses its port, data folder and host key, so its
// rooms, sessions and address carry on. Restarting a quick tunnel gives a
// new address: the directory gets it, members re-join with the new link.
//
// Everything here lives in module variables: a reload of the mod ends the
// children anyway (PLAN.md §8 Surfaces), and session.start then forgets the
// room (register.tsx).

import type { EngineInterface } from 'claude-code'
import { githubRepo, inviteLink, loginKey, permissionOf, repoUrlOf, roleFor } from '../protocol/join'
import type { GithubRepo, Invite } from '../protocol/join'
import type { HostEvent, HostRoom, Role, Room, RoomVisibility } from '../protocol/types'
import { StudioError, hostClient } from './api'
import { PANE_ID } from './commands'
import { publishRoom, readDirectory, unpublishRoom } from './directory'
import type { Listing } from './directory'
import { checkHost, roomHostPaths } from './hostcheck'
import { githubLogin } from './identity'
import { answers } from './listing'
import { deferred, describe, homeDir, inBackground, lastWords, pathIn, randomKey, runIfThere, spawnChild, withTimeout } from './processes'
import type { Child } from './processes'
import { expose } from './providers'
import type { Exposure, Provider } from './providers'
import { loadIdentity, loadSaved, saveSaved, setAccount, setJoins, updateHosting } from './state'
import type { Saved } from './state'
import { forgetRoom, startSync } from './sync'

const READY_WAIT_MS = 20_000
// At most this many of the host's older entries are asked whether they still
// answer: the branch is anyone's with push access, and could list thousands.
const MAX_PROBES = 10

type HostedRoom = { id: string; name: string; visibility: RoomVisibility; roomKey: string | null }

type Hosting = {
  hostKey: string
  port: number
  localUrl: string
  dataDir: string | null
  roomHostEntry: string
  relayEntry: string
  roomHost: Child
  exposure: Exposure | null
  restarts: { roomHost: number; tunnel: number }
  // The room host said it is exiting: its last room closed. No restart then.
  isExiting: boolean
  isStopping: boolean
  room: HostedRoom | null
  login: string
  // The session's folder: the repo the directory is written to.
  cwd: string
  isInRepo: boolean
  // A room host somebody started by hand, found by /room attach: not this
  // session's child, so nothing here starts, restarts or stops it.
  isAttached: boolean
}

// A Hosting with no process to supervise.
const NO_CHILD: Child = { stop: () => {}, ended: new Promise(() => {}), end: () => null }

let hosting: Hosting | undefined

export const isHosting = () => hosting !== undefined

export function hostApi($: EngineInterface) {
  return hosting === undefined ? null : hostClient($, hosting.localUrl, hosting.hostKey)
}

// The link for the room this session hosts, once it is reachable.
export function hostedInvite(): Invite | null {
  if (hosting?.room == null) return null
  // An attached room host has no address provider: its own loopback address
  // is all there is (another terminal on this machine can join through it).
  const address = hosting.exposure?.address ?? (hosting.isAttached ? hosting.localUrl : null)
  return address === null ? null : { roomId: hosting.room.id, address, roomKey: hosting.room.roomKey }
}

function parseHostEvent(line: string): HostEvent | null {
  try {
    const event = JSON.parse(line) as HostEvent
    return typeof event.event === 'string' ? event : null
  } catch {
    return null
  }
}

// --- the room host process -------------------------------------------------

async function startRoomHost(
  $: EngineInterface,
  entry: string,
  options: { port: number; dataDir: string | null; hostKey: string },
  onEvent: (event: HostEvent) => void,
): Promise<{ child: Child; port: number }> {
  const ready = deferred<number>()
  const argv = ['node', entry, '--port', String(options.port), ...(options.dataDir === null ? [] : ['--data', options.dataDir])]
  const child = spawnChild($, { argv, env: { STUDIO_HOST_KEY: options.hostKey } }, (line, pipe) => {
    const event = pipe === 'stdout' ? parseHostEvent(line) : null
    if (event?.event === 'ready') ready.resolve(event.port)
    else if (event !== null) onEvent(event)
  })
  const first = await withTimeout(
    $,
    Promise.race([ready.promise.then(port => ({ port })), child.ended.then(end => ({ end }))]),
    READY_WAIT_MS,
    `the room host did not start within ${READY_WAIT_MS / 1000} s`,
  ).catch(error => {
    child.stop()
    throw error
  })
  if ('end' in first) throw new Error(`the room host did not start (${lastWords(first.end)})`)
  return { child, port: first.port }
}

function onHostEvent(h: Hosting): (event: HostEvent) => void {
  return event => {
    if (event.event === 'exiting') h.isExiting = true
  }
}

// Ends hosting: children stopped, the directory entry removed. `lost`: why
// the room is gone against the host person's will (shown, and the room
// forgotten here); null for an ordinary end (the last member left).
async function finish($: EngineInterface, h: Hosting, lost: string | null): Promise<void> {
  if (hosting !== h) return
  hosting = undefined
  h.isStopping = true
  h.exposure?.child.stop()
  h.roomHost.stop()
  await setJoins($, [])
  if (lost === null) {
    await updateHosting($, () => null)
  } else {
    await updateHosting($, view => ({
      phase: 'lost',
      provider: view?.provider ?? null,
      address: view?.address ?? null,
      warning: null,
      note: `room lost: ${lost}`,
    }))
    const saved = await loadSaved($)
    if (saved?.isHost === true && saved.roomId === h.room?.id) await forgetRoom($)
    $.ui.toast(`Studio: room lost: ${lost}`)
  }
  if (h.room !== null && h.isInRepo) {
    const roomId = h.room.id
    inBackground($, unpublishRoom($, h.cwd, roomId, h.login))
  }
}

async function superviseRoomHost($: EngineInterface, h: Hosting): Promise<void> {
  for (;;) {
    const end = await h.roomHost.ended
    if (hosting !== h) return
    if (h.isStopping || h.isExiting || end.isStopped) return finish($, h, null)
    if (h.restarts.roomHost >= 1 || h.dataDir === null) return finish($, h, `the room host stopped (${lastWords(end)})`)

    h.restarts.roomHost += 1
    await updateHosting($, view => view && { ...view, phase: 'restarting', note: `the room host stopped (${lastWords(end)}): restarting it` })
    try {
      const again = await startRoomHost($, h.roomHostEntry, { port: h.port, dataDir: h.dataDir, hostKey: h.hostKey }, onHostEvent(h))
      h.roomHost = again.child
      // A new process: it knows its rooms from its data, not its addresses.
      if (h.exposure !== null) await hostClient($, h.localUrl, h.hostKey).setOrigins([h.exposure.address])
      await updateHosting($, view => view && { ...view, phase: 'up', note: 'the room host stopped and was restarted' })
    } catch (error) {
      return finish($, h, `the room host stopped and did not come back (${describe(error)})`)
    }
  }
}

async function superviseTunnel($: EngineInterface, h: Hosting): Promise<void> {
  for (;;) {
    const exposure = h.exposure
    if (exposure === null) return
    const end = await exposure.child.ended
    if (hosting !== h || h.isStopping || h.isExiting || end.isStopped) return
    const name = exposure.provider
    if (h.restarts.tunnel >= 1) return finish($, h, `${name} stopped again (${lastWords(end)})`)

    h.restarts.tunnel += 1
    await updateHosting($, view => view && { ...view, phase: 'restarting', note: `${name} stopped (${lastWords(end)}): restarting it` })
    try {
      const next = await expose($, name, h.port, h.relayEntry)
      h.exposure = next
      await hostClient($, h.localUrl, h.hostKey).setOrigins([next.address])
      const isMoved = next.address !== exposure.address
      await updateHosting($, view => view && {
        ...view,
        phase: 'up',
        address: next.address,
        note: isMoved ? `${name} restarted at a new address: members join again with the new link (/room invite)` : `${name} restarted`,
      })
      if (isMoved) {
        announce($, h)
        inBackground($, publish($, h))
      }
    } catch (error) {
      return finish($, h, `${name} stopped and did not come back (${describe(error)})`)
    }
  }
}

// --- reachability, the invite, the directory --------------------------------

function announce($: EngineInterface, h: Hosting): void {
  const invite = hostedInvite()
  if (invite === null || h.room === null) return
  // A transcript line, never sent to the model: a private room's link is a secret.
  $.ui.log(`Studio: ${h.room.name} is reachable at ${invite.address}. Invite link:\n${inviteLink(invite)}`)
  $.ui.toast(`Studio: ${h.room.name} is reachable: /room invite for the link`)
}

// The directory entry, with this host's entries that no longer answer dropped.
async function publish($: EngineInterface, h: Hosting): Promise<void> {
  const room = h.room
  const exposure = h.exposure
  if (!h.isInRepo || room === null || exposure === null) return
  try {
    const { entries } = await readDirectory($, h.cwd)
    const older = entries
      .flatMap(entry => (entry.visibility === 'open' && entry.id !== room.id && loginKey(entry.host) === h.login ? [entry] : []))
      .slice(0, MAX_PROBES)
    const isAlive = await Promise.all(older.map(entry => answers($, entry.address)))
    const dropIds = older.filter((_, at) => isAlive[at] !== true).map(entry => entry.id)
    const listing: Listing = {
      id: room.id,
      name: room.name,
      host: h.login,
      address: exposure.address,
      visibility: room.visibility,
      updatedAt: await $.clock.now(),
    }
    await publishRoom($, h.cwd, listing, room.roomKey, { login: h.login, dropIds })
  } catch (error) {
    $.ui.log(`Studio: the room is not in the room directory, so share its link (${describe(error)})`)
  }
}

async function exposeAndAnnounce($: EngineInterface, h: Hosting, providers: readonly Provider[]): Promise<void> {
  const failures: string[] = []
  for (const provider of providers) {
    if (hosting !== h) return
    await updateHosting($, view => view && { ...view, phase: provider === 'cloudflared' ? 'resolving' : 'exposing', provider })
    try {
      h.exposure = await expose($, provider, h.port, h.relayEntry)
      break
    } catch (error) {
      failures.push(describe(error))
    }
  }
  const exposure = h.exposure
  if (hosting !== h) {
    exposure?.child.stop()
    return
  }
  if (exposure === null) return finish($, h, `no way to reach it from other machines (${failures.join('; ')})`)
  try {
    await hostClient($, h.localUrl, h.hostKey).setOrigins([exposure.address])
  } catch (error) {
    return finish($, h, `the room host did not take its address (${describe(error)})`)
  }
  await updateHosting($, () => ({
    phase: 'up',
    provider: exposure.provider,
    address: exposure.address,
    warning: exposure.warning,
    note: failures.length === 0 ? null : `tried first: ${failures.join('; ')}`,
  }))
  inBackground($, superviseTunnel($, h))
  announce($, h)
  await publish($, h)
}

// --- creating a room -----------------------------------------------------------

async function repoOf($: EngineInterface, cwd: string): Promise<GithubRepo | null> {
  const origin = await runIfThere($, ['git', 'remote', 'get-url', 'origin'], { cwd }).catch(() => null)
  return origin?.exitCode === 0 ? githubRepo(origin.stdout.trim()) : null
}

// The host person's own role (D19), from what `gh` says they may do in the
// repo. Without gh: member. Without a repo there is no team: owner.
async function hostRole($: EngineInterface, repo: GithubRepo | null, login: string): Promise<{ role: Role; note: string | null }> {
  if (repo === null) return { role: 'owner', note: null }
  const name = `${repo.owner}/${repo.name}`
  const asMember = (why: string) => ({ role: 'member' as const, note: `${why}: you host as a member (private rooms need owner or admin)` })
  const user = await runIfThere($, ['gh', 'api', 'user', '--jq', '.login'], { timeoutMs: 15_000 }).catch(() => null)
  if (user === null) return asMember('gh is not installed')
  if (user.exitCode !== 0 || loginKey(user.stdout.trim()) !== loginKey(login)) return asMember(`gh is not signed in as ${login}`)
  const answer = await runIfThere($, ['gh', 'api', `repos/${name}`], { timeoutMs: 15_000 }).catch(() => null)
  if (answer?.exitCode !== 0) return asMember(`gh could not read ${name}`)
  let body: { permissions?: Record<string, boolean>; owner?: { login?: string; type?: string } }
  try {
    body = JSON.parse(answer.stdout)
  } catch {
    return asMember(`gh answered something unreadable for ${name}`)
  }
  const permission = permissionOf(body.permissions ?? {})
  let isOwner = loginKey(body.owner?.login ?? '') === loginKey(login)
  if (!isOwner && permission === 'admin' && body.owner?.type === 'Organization') {
    const membership = await runIfThere($, ['gh', 'api', `user/memberships/orgs/${repo.owner}`], { timeoutMs: 15_000 }).catch(() => null)
    isOwner = membership?.exitCode === 0 && /"role"\s*:\s*"admin"/.test(membership.stdout)
  }
  const role = roleFor({ isOwner, permission })
  if (role === null) throw new Error(`you have ${permission} access to ${name}; hosting a room for it needs write access`)
  return { role, note: null }
}

export type CreateOptions = { name: string; visibility: RoomVisibility; via: Provider | 'auto' }

// /room create: the room is open locally when this returns; reaching it from
// elsewhere goes on in the background (the pane and a transcript line say
// when it is ready).
// Refuses a second room host in one session.
function refuseSecond(): void {
  if (hosting === undefined) return
  throw new Error(hosting.isAttached ? 'this session is attached to a room host already: /room leave first' : 'this session hosts a room already')
}

export async function createRoom($: EngineInterface, options: CreateOptions): Promise<string> {
  refuseSecond()
  if ((await loadSaved($)) !== null) throw new Error('you are in a room: /room leave first')

  const login = (await loadIdentity($))?.login ?? (await githubLogin($))
  if (login === null) throw new Error('which GitHub login is yours? Run /studio login <your-github-login> first')
  // Before anything starts: what this machine lacks, named once.
  const { providers, note: reachNote } = await checkHost($, { via: options.via })
  const { roomHostEntry, relayEntry } = roomHostPaths($.plugin.root)
  const cwd = await $.session.root()
  const repo = await repoOf($, cwd)
  const { role, note: roleNote } = await hostRole($, repo, login)
  if (options.visibility === 'private' && role !== 'owner' && role !== 'admin') {
    throw new Error(roleNote ?? 'only owners and admins of the repo create private rooms')
  }
  const note = [roleNote, reachNote].filter(line => line !== null).join('\n') || null
  const home = await homeDir($)
  const dataDir = home === null ? null : pathIn(home.path, '.claude', 'studio', 'room-hosts', randomKey().slice(0, 12))
  const hostKey = randomKey()

  const h: Hosting = {
    hostKey,
    port: 0,
    localUrl: '',
    dataDir,
    roomHostEntry,
    relayEntry,
    roomHost: NO_CHILD,
    exposure: null,
    restarts: { roomHost: 0, tunnel: 0 },
    isExiting: false,
    isStopping: false,
    room: null,
    login: loginKey(login),
    cwd,
    isInRepo: repo !== null,
    isAttached: false,
  }
  const started = await startRoomHost($, roomHostEntry, { port: 0, dataDir, hostKey }, onHostEvent(h))
  h.roomHost = started.child
  h.port = started.port
  h.localUrl = `http://127.0.0.1:${started.port}`
  hosting = h
  await updateHosting($, () => ({ phase: 'starting', provider: null, address: null, warning: null, note }))
  inBackground($, superviseRoomHost($, h))

  let created
  try {
    created = await hostClient($, h.localUrl, hostKey).createRoom({
      name: options.name,
      visibility: options.visibility,
      repoUrl: repo === null ? undefined : repoUrlOf(repo),
      login,
      role,
    })
  } catch (error) {
    await finish($, h, null)
    throw error
  }
  const { room, token, roomKey } = created
  h.room = { id: room.id, name: room.name, visibility: room.visibility, roomKey }
  await saveSaved($, { hostUrl: h.localUrl, roomId: room.id, token, login: room.hostLogin, isHost: true, roomKey })
  await setAccount($, { login: room.hostLogin, role, hostUrl: h.localUrl })
  startSync($)
  inBackground($, $.ui.open({ id: PANE_ID, title: `room: ${room.name}` }))
  inBackground($, exposeAndAnnounce($, h, providers))

  const how = providers.length === 1 ? providers[0] : `${providers.join(', then ')}`
  return [
    `${room.name} is open on this machine${repo === null ? '' : ` for ${repo.owner}/${repo.name}`}.`,
    `Making it reachable (${how}); the invite link prints here once the address answers.`,
    ...(note === null ? [] : [note]),
  ].join('\n')
}

// The host person's own end of hosting (the mod's session ending is the
// other): ask the room host to exit; the supervisor cleans up after it.
export async function stopHosting($: EngineInterface): Promise<void> {
  const h = hosting
  if (h === undefined) return
  h.isStopping = true
  await hostClient($, h.localUrl, h.hostKey).close().catch(() => undefined)
  await finish($, h, null)
}

// --- a room host started by hand ----------------------------------------------
//
// A reload of the mod ends the room host it spawned (PLAN.md §8 Surfaces), so
// while developing the mod the room host runs on its own (`pnpm dev`) and the
// session attaches to it. The session then holds the same Hosting as after
// /room create, minus the processes: pending joins and /room invite work, and
// nothing here starts, restarts or stops the room host.

const DEV_ROOM = 'dev'
const ATTACHED_WARNING = 'attached to a room host started by hand: other machines reach it only if you expose it yourself'

// The address of a room host on this machine, as `http://127.0.0.1:<port>`:
// the only kind the host key is ever sent to.
export function loopbackOrigin(text: string): string | null {
  try {
    const url = new URL(text.trim())
    const isLocal = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    return url.protocol === 'http:' && isLocal && url.port !== '' ? `http://${url.hostname}:${url.port}` : null
  } catch {
    return null
  }
}

export type AttachOptions = { url: string; hostKey: string; room?: string }

export async function attachRoomHost($: EngineInterface, options: AttachOptions): Promise<string> {
  refuseSecond()
  if ((await loadSaved($)) !== null) throw new Error('you are in a room: /room leave first')
  const localUrl = loopbackOrigin(options.url)
  if (localUrl === null) {
    throw new Error(`${options.url} is not a room host on this machine: give http://127.0.0.1:<port>, since the host key must not leave it`)
  }

  const api = hostClient($, localUrl, options.hostKey)
  await api.health().catch(() => {
    throw new Error(`no room host answers at ${localUrl}: start one with pnpm dev`)
  })
  let rooms: HostRoom[]
  try {
    rooms = await api.rooms()
  } catch (error) {
    if (error instanceof StudioError && error.status === 401) {
      throw new Error(`${localUrl} did not accept that host key (the room host prints its key when it starts)`)
    }
    throw error
  }

  // The room to join: the one asked for, the only one there is, or a new one.
  const wanted = options.room?.toLowerCase()
  const names = rooms.map(room => `"${room.name}"`).join(', ')
  let room: HostRoom | undefined
  if (wanted !== undefined) {
    room = rooms.find(known => known.id === wanted || known.name.toLowerCase() === wanted)
    if (room === undefined && rooms.length > 0) throw new Error(`no open room "${options.room}" there; open rooms: ${names}`)
  } else if (rooms.length === 1) {
    room = rooms[0]
  } else if (rooms.length > 1) {
    throw new Error(`${rooms.length} rooms are open there (${names}): /room attach --room <name>`)
  }
  if (room?.visibility === 'private') {
    throw new Error(`"${room.name}" is private: its key was shown once when it was created, so no invite link can be made for it here`)
  }

  let session: { room: Room; token: string; role: Role }
  if (room === undefined) {
    const login = (await loadIdentity($))?.login ?? (await githubLogin($))
    if (login === null) throw new Error('which GitHub login is yours? Run /studio login <your-github-login> first')
    const created = await api.createRoom({ name: options.room ?? DEV_ROOM, visibility: 'open', login, role: 'owner' })
    session = { room: created.room, token: created.token, role: 'owner' }
  } else {
    // The host person comes back into their own room with a fresh session token,
    // in the role they hold: login, role and room all as the room host lists them.
    const host = room.members.find(member => member.login === room.hostLogin)
    if (host === undefined) throw new Error(`"${room.name}" lists ${room.hostLogin} as its host, but not among its members`)
    const admitted = await api.admitMember(room.id, { login: room.hostLogin, role: host.role, verified: true })
    session = { room: admitted.room, token: admitted.token, role: host.role }
  }

  const h: Hosting = {
    hostKey: options.hostKey,
    port: Number(new URL(localUrl).port),
    localUrl,
    dataDir: null,
    roomHostEntry: '',
    relayEntry: '',
    roomHost: NO_CHILD,
    exposure: null,
    restarts: { roomHost: 0, tunnel: 0 },
    isExiting: false,
    isStopping: false,
    room: { id: session.room.id, name: session.room.name, visibility: session.room.visibility, roomKey: null },
    login: loginKey(session.room.hostLogin),
    cwd: await $.session.root(),
    isInRepo: false,
    isAttached: true,
  }
  hosting = h
  const saved: Saved = {
    hostUrl: localUrl,
    roomId: session.room.id,
    token: session.token,
    login: session.room.hostLogin,
    isHost: true,
    isAttached: true,
    roomKey: null,
  }
  await saveSaved($, saved)
  await setAccount($, { login: saved.login, role: session.role, hostUrl: localUrl })
  await updateHosting($, () => ({ phase: 'up', provider: null, address: localUrl, warning: ATTACHED_WARNING, note: null }))
  startSync($)
  inBackground($, $.ui.open({ id: PANE_ID, title: `room: ${session.room.name}` }))
  return [
    `Attached to the room host at ${localUrl}: you are in "${session.room.name}" as ${saved.login} (${session.role}).`,
    `/room invite makes a link that works on this machine (another terminal); ${ATTACHED_WARNING.replace(/^attached to a room host started by hand: /, '')}.`,
  ].join('\n')
}

// The session is out of the room it attached to: nothing to stop, the room
// host is not its child.
export async function detachHost($: EngineInterface): Promise<void> {
  const h = hosting
  if (h === undefined || !h.isAttached) return
  hosting = undefined
  await setJoins($, [])
  await updateHosting($, () => null)
}
