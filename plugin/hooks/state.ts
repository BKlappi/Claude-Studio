import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { resolveModels, slotModels } from '../protocol/models'
import type { ModelSlot, RoomModels } from '../protocol/types'
import type { Account, HandoverView, HostingView, JoiningView, PendingJoinView, RoomView, RunChoice, RunView, SyncState } from '../types'

// Every $.state read and write goes through this file: `claude plugin
// validate` reads atoms where they are written, so they stay here.

// Session values the pane draws from (they survive a hot reload).
const account = atom({ plugin: 'studio', key: 'account' } as const, null)
const roomView = atom({ plugin: 'studio', key: 'roomView' } as const, null)
const sync = atom({ plugin: 'studio', key: 'sync' } as const, { lastOkAt: null, error: null, failures: 0, queued: 0 })
const hosting = atom({ plugin: 'studio', key: 'hosting' } as const, null)
const joins = atom({ plugin: 'studio', key: 'joins' } as const, [])
const joining = atom({ plugin: 'studio', key: 'joining' } as const, null)
const handover = atom({ plugin: 'studio', key: 'handover' } as const, null)
const runs = atom({ plugin: 'studio', key: 'runs' } as const, {})
const expanded = atom({ plugin: 'studio', key: 'expanded' } as const, [])
const approvals = atom({ plugin: 'studio', key: 'approvals' } as const, {})

export const LOG_KEEP = 200
// What the mirror keeps at most: the entries the coordinator has not read
// yet, past LOG_KEEP (sync.ts mergeSnapshot).
export const LOG_MIRROR_MAX = 1000

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

export function getHandover($: EngineInterface) {
  return read($, handover)
}
export function setHandover($: EngineInterface, value: HandoverView | null) {
  return update($, handover, () => value)
}

export function getRuns($: EngineInterface) {
  return read($, runs)
}
// A task's run (hooks/runs.ts); null forgets it.
export function setRun($: EngineInterface, taskId: string, run: RunView | null) {
  return update($, runs, current => {
    const { [taskId]: _, ...rest } = current
    return run === null ? rest : { ...rest, [taskId]: run }
  })
}
// Drops the runs of tasks that are no longer this person's, unless still running.
export function keepRuns($: EngineInterface, taskIds: readonly string[]) {
  return update($, runs, current => {
    const kept = Object.entries(current).filter(([id, run]) => taskIds.includes(id) || run.phase === 'starting' || run.phase === 'running' || run.phase === 'reviewing')
    return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept)
  })
}

export function getExpanded($: EngineInterface) {
  return read($, expanded)
}
export function toggleExpanded($: EngineInterface, taskId: string) {
  return update($, expanded, ids => (ids.includes(taskId) ? ids.filter(id => id !== taskId) : [...ids, taskId]))
}

export function getApprovals($: EngineInterface) {
  return read($, approvals)
}
// The answer to a task's approval card; null takes it back (the card asks again).
export function setApproval($: EngineInterface, taskId: string, choice: RunChoice | null) {
  return update($, approvals, current => {
    const { [taskId]: _, ...rest } = current
    return choice === null ? rest : { ...rest, [taskId]: choice }
  })
}
// Drops the answers about tasks that are no longer this person's to run.
export function keepApprovals($: EngineInterface, taskIds: readonly string[]) {
  return update($, approvals, current => {
    const kept = Object.entries(current).filter(([id]) => taskIds.includes(id))
    return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept)
  })
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
  // Room mode (PLAN.md D21): what the person types goes to the room, not to
  // their own Claude. On unless this says false; /room mode off keeps it off
  // across restarts, since the room reads what they type.
  roomMode?: boolean
  // The room's secret, from its snapshots: a new address must prove it holds
  // it (protocol/seal.ts hostProof) before this session moves there.
  roomSecret?: string
}

export const isRoomMode = (saved: Saved | null): boolean => saved !== null && saved.roomMode !== false

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

// The model slots (spec, "Planning and Model Slots"; /studio models). The
// coordinator runs on the medium one.
export const DEFAULT_MODELS: Record<ModelSlot, string> = {
  hard: 'claude-opus-5-5',
  medium: 'claude-sonnet-5-5',
  easy: 'claude-haiku-5-5',
}

// What this person chose for the work their own machine runs: only the slots
// they set. (A file from before room defaults holds all three.)
export async function loadOwnModels($: EngineInterface): Promise<RoomModels> {
  return slotModels(await $.store.get('models'))
}

export async function saveOwnModels($: EngineInterface, own: RoomModels): Promise<void> {
  await $.store.set('models', own)
}

// The model of each slot for work on this machine, and where it comes from:
// the person's own choice, else the room's default, else Studio's.
export async function resolveSlots($: EngineInterface) {
  const view = await getRoomView($)
  return resolveModels(DEFAULT_MODELS, view?.room.models, await loadOwnModels($))
}

export async function loadModels($: EngineInterface): Promise<Record<ModelSlot, string>> {
  return (await resolveSlots($)).models
}

// What the account check found out about a model id (hooks/models.ts), kept so
// a model is asked about once, not at every command.
export type ModelCheck = { ok: boolean; why: string | null; at: number }

export async function loadModelChecks($: EngineInterface): Promise<Record<string, ModelCheck>> {
  const found = (await $.store.get('modelChecks')) as Record<string, ModelCheck> | undefined
  return typeof found === 'object' && found !== null ? found : {}
}

export async function saveModelChecks($: EngineInterface, checks: Record<string, ModelCheck>): Promise<void> {
  await $.store.set('modelChecks', checks)
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
