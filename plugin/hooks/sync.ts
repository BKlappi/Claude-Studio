import type { EngineInterface, Timer } from 'claude-code'
import type { RoomSnapshot } from '../protocol/types'
import type { RoomView } from '../types'
import { StudioError, client, isOutOfRoom } from './api'
import { detachHost, hostApi } from './hosting'
import { inBackground } from './processes'
import { LOG_KEEP, getRoomView, loadSaved, saveSaved, setAccount, setJoins, setRoomView, updateRoomView, updateSync } from './state'

// v0 polls the room snapshot. PLAN.md phase 3 swaps this for a long-poll;
// the merge below stays the same, as it is cursor-based.
export const POLL_MS = 3000

// Module variables: a hot reload drops them, and session.start (which runs
// again on reload) restarts the loop.
let timer: Timer | undefined
let isBusy = false
const pendingFiles = new Set<string>()

export function queueFile(path: string): void {
  pendingFiles.add(path)
}

export function startSync($: EngineInterface): void {
  stopSync()
  timer = $.clock.every(POLL_MS, () => {
    inBackground($, refresh($))
  })
  inBackground($, refresh($))
}

export function stopSync(): void {
  timer?.cancel()
  timer = undefined
  pendingFiles.clear()
}

// This session is out of its room (left, removed, or the room closed):
// forget it everywhere.
export async function forgetRoom($: EngineInterface): Promise<void> {
  stopSync()
  await detachHost($)
  await saveSaved($, null)
  await setAccount($, null)
  await setRoomView($, null)
}

export function mergeSnapshot(current: RoomView | null, snap: RoomSnapshot): RoomView {
  const isSameRoom = current !== null && current.room.id === snap.room.id
  const log = isSameRoom ? [...current.log, ...snap.log] : snap.log
  return {
    room: snap.room,
    members: snap.members,
    tasks: snap.tasks,
    log: log.slice(-LOG_KEEP),
    statusText: snap.statusText,
    cursor: snap.cursor,
  }
}

export async function refresh($: EngineInterface): Promise<void> {
  if (isBusy) return
  isBusy = true
  try {
    const saved = await loadSaved($)
    if (saved === null) return
    const api = client($, saved)

    if (pendingFiles.size > 0) {
      const paths = [...pendingFiles]
      pendingFiles.clear()
      await api.reportFiles(paths).catch(() => {
        for (const path of paths) pendingFiles.add(path)
      })
    }

    const view = await getRoomView($)
    const since = view !== null && view.room.id === saved.roomId ? view.cursor : 0
    const snap = await api.snapshot(since)
    await updateRoomView($, current => mergeSnapshot(current, snap))
    // The host person sees who waits to be let in (PLAN.md phase 1, D6).
    let problem: string | null = null
    const host = saved.isHost === true ? hostApi($) : null
    if (host !== null) {
      const waiting = await host.joins().catch(error => {
        // A room host started by hand restarts with a new key unless STUDIO_HOST_KEY holds one.
        if (error instanceof StudioError && error.status === 401) {
          problem = 'the room host no longer takes the host key this session has (it restarted with a new one): /room leave, then /room attach'
        }
        return null
      })
      if (waiting !== null) await setJoins($, waiting.filter(request => request.roomId === saved.roomId))
    }
    const at = await $.clock.now()
    await updateSync($, () => ({ lastOkAt: at, error: problem }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateSync($, state => ({ ...state, error: message }))
    if (isOutOfRoom(error)) {
      await forgetRoom($)
      $.ui.toast(`Studio: ${message}`)
    }
  } finally {
    isBusy = false
  }
}
