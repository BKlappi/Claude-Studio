import type { EngineInterface, Timer } from 'claude-code'
import { HOST_LOST_MS, handoverIn } from '../protocol/handover'
import type { CreateTaskRequest, RoomSnapshot } from '../protocol/types'
import type { RoomView } from '../types'
import { runnableIds } from './approval'
import { StudioError, client, isOffline, isOutOfRoom } from './api'
import { canFollowRoom, isMoving, onHandover, onHostLost, reportCanHost, stopMoving } from './handover'
import { detachHost, hostApi } from './hosting'
import { describe, inBackground } from './processes'
import { LOG_KEEP, LOG_MIRROR_MAX, getHosting, getRoomView, getSync, isRoomMode, keepApprovals, keepRuns, loadSaved, saveSaved, setAccount, setHandover, setJoins, setRoomView, updateRoomView, updateSync } from './state'
import type { Saved } from './state'
import { connectionText, modeText } from './summary'

// The room reaches this session through a long-poll (PLAN.md phase 3): the
// room host holds each snapshot request until something happens, or WAIT_MS,
// and the next one goes out as soon as it answers. A room host from before
// phase 3 answers at once; it is asked every POLL_MS instead.
//
// Sending is apart from receiving: what the person types goes out at once,
// whether or not a long-poll is waiting.
export const POLL_MS = 3000
export const POLL_MAX_MS = 30000
export const WAIT_MS = 25000

// The wait before the next poll after `failures` failed ones in a row: the
// first miss tries again at the normal pace (a blip), then 6, 12, 24, 30 s.
export function pollDelay(failures: number): number {
  return Math.min(POLL_MAX_MS, POLL_MS * 2 ** Math.max(0, failures - 1))
}

// Module variables: a hot reload drops them, and session.start (which runs
// again on reload) restarts the loop.
let timer: Timer | undefined
// The loop startSync began; stopSync ends it, a poll still under way too.
let loop: { isStopped: boolean } | undefined
// Redraws the pane once a second while the coordinator's batching window is open.
let countdown: Timer | undefined
const pendingFiles = new Set<string>()

export function queueFile(path: string): void {
  pendingFiles.add(path)
}

// What the person typed while the room host did not answer, sent in order once
// it does. A request that reached the host but whose answer got lost is sent
// twice: rare, and a repeated message is cheap.
export type Outgoing = { kind: 'say'; body: string } | { kind: 'task'; input: CreateTaskRequest }
const outbox: Outgoing[] = []
const OUTBOX_MAX = 50
// One flush at a time: two at once would send the same item twice.
let flushing: Promise<void> = Promise.resolve()

// What this session said lately, with the seqs its room host gave it: after a
// handover, what the new host's log does not hold is said again (handover.ts).
const sent: { seq: number; body: string }[] = []
const SENT_KEEP = 30

export function sentAfter(seq: number): string[] {
  const lost = sent.filter(message => message.seq > seq).map(message => message.body)
  sent.length = 0
  return lost
}

type RoomClient = ReturnType<typeof client>

async function send(api: RoomClient, item: Outgoing): Promise<void> {
  if (item.kind === 'say') {
    const entry = await api.say(item.body)
    sent.push({ seq: entry.seq, body: item.body })
    if (sent.length > SENT_KEEP) sent.shift()
  } else await api.createTask(item.input)
}

// Sends `item` now, or queues it when the room host does not answer or an
// earlier one still waits (they go out in the order they were typed).
export async function post($: EngineInterface, api: RoomClient, item: Outgoing): Promise<'sent' | 'queued'> {
  if (outbox.length === 0) {
    try {
      await send(api, item)
      return 'sent'
    } catch (error) {
      if (!isOffline(error)) throw error
    }
  }
  if (outbox.length >= OUTBOX_MAX) throw new StudioError(0, `the room host does not answer, and ${OUTBOX_MAX} messages already wait`)
  outbox.push(item)
  await updateSync($, state => ({ ...state, queued: outbox.length }))
  return 'queued'
}

// Puts `item` in the outbox to go out with the next send, without waiting on
// the network: a prompt hook has 10 s, and one that outlasts them is skipped,
// which would let the prompt through to the person's own Claude.
export async function enqueue($: EngineInterface, item: Outgoing): Promise<void> {
  if (outbox.length >= OUTBOX_MAX) throw new StudioError(0, `${OUTBOX_MAX} messages already wait to go to the room`)
  outbox.push(item)
  await updateSync($, state => ({ ...state, queued: outbox.length }))
}

async function flushOnce($: EngineInterface, api: RoomClient): Promise<void> {
  for (let item = outbox[0]; item !== undefined; item = outbox[0]) {
    try {
      await send(api, item)
    } catch (error) {
      // Offline, or out of the room: the caller deals with it, and the rest
      // stays queued.
      if (isOffline(error) || isOutOfRoom(error)) throw error
      // The room host refused it for good (a blank title, ...).
      $.ui.toast(`Studio: dropped a queued ${item.kind === 'say' ? 'message' : 'task'}: ${describe(error)}`)
    }
    outbox.shift()
  }
  if (pendingFiles.size > 0) {
    const paths = [...pendingFiles]
    pendingFiles.clear()
    await api.reportFiles(paths).catch(() => {
      for (const path of paths) pendingFiles.add(path)
    })
  }
}

// Sends what waits: the outbox, in order, then the file reports.
function flush($: EngineInterface, api: RoomClient): Promise<void> {
  const run = flushing.catch(() => undefined).then(() => flushOnce($, api))
  flushing = run
  return run
}

// What waits to be sent stays: after a move to a new host it goes there
// (forgetRoom is what empties it).
export function startSync($: EngineInterface): void {
  pauseSync()
  const mine = { isStopped: false }
  loop = mine
  const poll = async (): Promise<void> => {
    const next = await receive($, mine)
    if (mine.isStopped || next === null) return
    if (next === 0) inBackground($, poll())
    else timer = $.clock.after(next, () => inBackground($, poll()))
  }
  inBackground($, poll())
}

// Stops reading the room, and keeps what waits to be sent: the room is moving
// to another host, and it goes there (handover.ts).
export function pauseSync(): void {
  if (loop !== undefined) loop.isStopped = true
  loop = undefined
  timer?.cancel()
  timer = undefined
  countdown?.cancel()
  countdown = undefined
}

export function stopSync(): void {
  pauseSync()
  pendingFiles.clear()
  outbox.length = 0
  sent.length = 0
}

// This session is out of its room (left, removed, or the room closed):
// forget it everywhere.
export async function forgetRoom($: EngineInterface): Promise<void> {
  stopSync()
  stopMoving()
  await setHandover($, null)
  await detachHost($)
  await saveSaved($, null)
  await setAccount($, null)
  await setRoomView($, null)
  await updateSync($, state => ({ ...state, failures: 0, queued: 0 }))
  $.ui.status(undefined)
}

// The room as this session knows it, with `snap` added. Two answers can cross
// (a long-poll and a refresh after a command): one older than what is shown
// is dropped, and no log entry is added twice.
//
// The log is also this session's mirror of the room (PLAN.md §5): besides the
// last LOG_KEEP entries it keeps all the coordinator has not read yet, so a
// successor carries those over.
export function mergeSnapshot(current: RoomView | null, snap: RoomSnapshot): RoomView {
  const isSameRoom = current !== null && current.room.id === snap.room.id
  if (isSameRoom && snap.cursor < current.cursor) return current
  const log = isSameRoom ? [...current.log, ...snap.log.filter(entry => entry.seq > current.cursor)] : snap.log
  const cursor = snap.state?.coordinatorCursor ?? Infinity
  const unread = log.findIndex(entry => entry.seq > cursor)
  const from = Math.max(log.length - LOG_MIRROR_MAX, Math.min(log.length - LOG_KEEP, unread === -1 ? Infinity : unread), 0)
  return {
    room: snap.room,
    members: snap.members,
    tasks: snap.tasks,
    log: log.slice(from),
    statusText: snap.statusText,
    // A room host from before the coordinator sends no window and no state.
    batch: snap.batch ?? null,
    state: snap.state ?? null,
    cursor: snap.cursor,
  }
}

// The pane counts the batching window down from when the room host answered
// (PLAN.md §5): a redraw each second until it has run out. Every answer sets
// it right again.
function startCountdown($: EngineInterface, closesInMs: number | null): void {
  countdown?.cancel()
  countdown = undefined
  if (closesInMs === null) return
  let ticks = Math.ceil(closesInMs / 1000)
  const tick = () => {
    $.ui.invalidate('ui.render')
    ticks -= 1
    if (ticks > 0) countdown = $.clock.after(1000, tick)
  }
  if (ticks > 0) countdown = $.clock.after(1000, tick)
}

// The status line: the room and whether its host answers.
async function showStatus($: EngineInterface): Promise<void> {
  const view = await getRoomView($)
  if (view === null) {
    $.ui.status(undefined)
    return
  }
  const mode = modeText(isRoomMode(await loadSaved($)))
  $.ui.status(`studio · ${view.room.name} · ${connectionText(await getSync($), await getHosting($))} · ${mode}`)
}

const isSameSession = (a: Saved | null, b: Saved) => a !== null && a.roomId === b.roomId && a.token === b.token && a.hostUrl === b.hostUrl

// One snapshot, merged: at once (waitMs 0) or as a long-poll. null when the
// session moved on meanwhile (left, joined elsewhere, followed a new host),
// so the answer is no longer this session's.
async function pull($: EngineInterface, saved: Saved, waitMs: number): Promise<RoomSnapshot | null> {
  const api = client($, saved)
  const view = await getRoomView($)
  const since = view !== null && view.room.id === saved.roomId ? view.cursor : 0
  // A first load is answered at once anyway.
  const snap = await api.snapshot(since, since === 0 ? 0 : waitMs)
  const latest = await loadSaved($)
  if (latest === null || !isSameSession(latest, saved)) return null
  let isNewer = false
  let previous = 0
  await updateRoomView($, current => {
    previous = current !== null && current.room.id === snap.room.id ? current.cursor : 0
    const merged = mergeSnapshot(current, snap)
    isNewer = merged !== current
    return merged
  })
  if (!isNewer) return snap
  // The room's secret, kept out of $.state; a new one after someone was removed.
  const current = snap.roomSecret === undefined || snap.roomSecret === latest.roomSecret ? latest : { ...latest, roomSecret: snap.roomSecret }
  if (current !== latest) await saveSaved($, current)
  // What this machine can do, once per session token (a new host gets it too).
  inBackground($, reportCanHost($, current, snap.room))
  // The host hands the room over (PLAN.md §5): everyone else follows it.
  for (const entry of snap.log) {
    const handover = entry.seq > previous && previous > 0 ? handoverIn(entry) : null
    if (handover !== null) onHandover($, latest, handover)
  }
  // What this person said to a task's card only counts while the task is theirs.
  await keepApprovals($, runnableIds(snap.tasks, saved.login))
  await keepRuns($, runnableIds(snap.tasks, saved.login))
  startCountdown($, snap.batch?.closesInMs ?? null)
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
  await updateSync($, () => ({ lastOkAt: at, error: problem, failures: 0, queued: outbox.length }))
  await showStatus($)
  return snap
}

// A request failed: out of the room (forget it), or not answered (count it).
async function failed($: EngineInterface, saved: Saved, error: unknown): Promise<void> {
  if (!isSameSession(await loadSaved($), saved)) return
  const message = describe(error)
  const isGone = isOutOfRoom(error)
  await updateSync($, state => ({ ...state, error: message, failures: isGone ? 0 : state.failures + 1, queued: outbox.length }))
  if (isGone) {
    await forgetRoom($)
    $.ui.toast(`Studio: ${message}`)
    return
  }
  await showStatus($)
  // Quiet for HOST_LOST_MS: the host's machine is gone (PLAN.md §5). A room
  // with a directory to look in is looked for elsewhere.
  const { lastOkAt } = await getSync($)
  const view = await getRoomView($)
  if (saved.isHost === true || isMoving() || lastOkAt === null || view === null) return
  if ((await $.clock.now()) - lastOkAt >= HOST_LOST_MS && (await canFollowRoom($))) onHostLost($, saved, view.room.hostLogin)
}

// After a failure, the next try: the backoff, but never past the moment the
// host counts as lost, so that moment is noticed on time.
async function retryDelay($: EngineInterface, saved: Saved): Promise<number> {
  const { failures, lastOkAt } = await getSync($)
  const backoff = pollDelay(failures)
  if (saved.isHost === true || lastOkAt === null || !(await canFollowRoom($))) return backoff
  const untilLost = lastOkAt + HOST_LOST_MS - (await $.clock.now())
  return untilLost > 0 ? Math.min(backoff, untilLost) : backoff
}

// The loop's step: send what waits, then wait for news. The milliseconds until
// the next step, or null when there is no room any more.
async function receive($: EngineInterface, mine: { isStopped: boolean }): Promise<number | null> {
  const saved = await loadSaved($)
  if (saved === null || mine.isStopped) return null
  try {
    await flush($, client($, saved))
    const snap = await pull($, saved, WAIT_MS)
    return snap?.canWait === true ? 0 : POLL_MS
  } catch (error) {
    await failed($, saved, error)
    if (isMoving()) return null
    return retryDelay($, saved)
  }
}

// Now, rather than with the next answer: send what waits and read the room
// (after a command, a press in the pane, a prompt sent to the room).
export async function refresh($: EngineInterface): Promise<void> {
  const saved = await loadSaved($)
  if (saved === null) return
  try {
    await flush($, client($, saved))
    await pull($, saved, 0)
  } catch (error) {
    await failed($, saved, error)
  }
}
