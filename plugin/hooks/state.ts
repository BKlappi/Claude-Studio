import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Account, HostingView, JoiningView, PendingJoinView, RoomView, SyncState } from '../types'

// Every $.state read and write goes through this file: `claude plugin
// validate` reads atoms where they are written, so they stay here.

// Session values the pane draws from (they survive a hot reload).
const account = atom({ plugin: 'studio', key: 'account' } as const, null)
const roomView = atom({ plugin: 'studio', key: 'roomView' } as const, null)
const sync = atom({ plugin: 'studio', key: 'sync' } as const, { lastOkAt: null, error: null })
const hosting = atom({ plugin: 'studio', key: 'hosting' } as const, null)
const joins = atom({ plugin: 'studio', key: 'joins' } as const, [])
const joining = atom({ plugin: 'studio', key: 'joining' } as const, null)

export const LOG_KEEP = 200

export function getAccount($: EngineInterface) {
  return read($, account)
}
export function setAccount($: EngineInterface, value: Account | null) {
  return update($, account, () => value)
}

export function getRoomView($: EngineInterface) {
  return read($, roomView)
}
export function setRoomView($: EngineInterface, value: RoomView | null) {
  return update($, roomView, () => value)
}
export function updateRoomView($: EngineInterface, change: (value: RoomView | null) => RoomView | null) {
  return update($, roomView, change)
}

export function getSync($: EngineInterface) {
  return read($, sync)
}
export function updateSync($: EngineInterface, change: (value: SyncState) => SyncState) {
  return update($, sync, change)
}

export function getHosting($: EngineInterface) {
  return read($, hosting)
}
export function updateHosting($: EngineInterface, change: (value: HostingView | null) => HostingView | null) {
  return update($, hosting, change)
}

export function getJoins($: EngineInterface) {
  return read($, joins)
}
export function setJoins($: EngineInterface, value: PendingJoinView[]) {
  return update($, joins, () => value)
}

export function getJoining($: EngineInterface) {
  return read($, joining)
}
export function setJoining($: EngineInterface, value: JoiningView | null) {
  return update($, joining, () => value)
}

// The room this session is in, kept across sessions in the mod's own $.store
// file. The token lives here, never in $.state, which any plugin can read.
export type Saved = {
  // The room host's address, as the joiner dialled it.
  hostUrl: string
  roomId: string
  // The per-room session token the host issued (PLAN.md D9).
  token: string
  login: string
  // This session's mod runs the room host (hostUrl is then its loopback
  // address): it ends with the session, or with a reload of the mod.
  isHost?: boolean
  // With isHost: that room host was started by hand and attached to
  // (/room attach), so it outlives this session.
  isAttached?: boolean
  // A private room's key, from the invite link or the room's creation.
  roomKey?: string | null
}

const SAVED_KEY = 'room'

export async function loadSaved($: EngineInterface): Promise<Saved | null> {
  const value = (await $.store.get(SAVED_KEY)) as Partial<Saved> | undefined
  const isWhole = value?.hostUrl && value.roomId && value.token && value.login
  return isWhole ? (value as Saved) : null
}

export async function saveSaved($: EngineInterface, saved: Saved | null): Promise<void> {
  if (saved === null) await $.store.delete(SAVED_KEY)
  else await $.store.set(SAVED_KEY, saved)
}

// The GitHub login this person goes by, and the SSH key that proves it
// (PLAN.md D6): `/studio login` links them once.
export type Identity = {
  login: string
  // What ssh-keygen -Y sign takes as -f: a private key without passphrase,
  // or a public key file whose private half the agent holds. null: no key
  // GitHub lists for the login could be used; `noKey` says why.
  keyFile: string | null
  // "type base64" of that key.
  publicKey: string | null
  noKey?: string
}

const IDENTITY_KEY = 'identity'

export async function loadIdentity($: EngineInterface): Promise<Identity | null> {
  const value = (await $.store.get(IDENTITY_KEY)) as Partial<Identity> | undefined
  return typeof value?.login === 'string' ? ({ keyFile: null, publicKey: null, ...value } as Identity) : null
}

export async function saveIdentity($: EngineInterface, identity: Identity): Promise<void> {
  await $.store.set(IDENTITY_KEY, identity)
}
