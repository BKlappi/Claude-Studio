// Handover, the mod's side (PLAN.md §5, phase 3): the room outlives its host.
//
//   planned    the host leaves (/room leave, quitting Claude Code): its room
//              writes a `handover` entry naming the successor and stops soon
//              after. The successor carries the room on from its mirror; the
//              others follow it there.
//   unplanned  the host stops answering: after HOST_LOST_MS the candidates
//              (successor order, those who were here) take their turn
//              CANDIDATE_GAP_MS apart; the first to claim the directory entry
//              hosts, the others follow.
//
// Following is the same either way: the directory (D17) names the room's new
// address; the room host there must prove it holds the room's secret before
// anything is sent to it (protocol/seal.ts hostProof); then the session joins
// it again on its SSH signature (the roster carries its role over), or, when
// the room host is the same one at a new address (a quick tunnel restarted),
// simply carries on with its token.
//
// Every member's mirror is its RoomView: room, members, tasks, state, the log
// since the coordinator's cursor (sync.ts keeps it). What this session sent
// that the new host's log does not hold is sent again.

import type { EngineInterface } from 'claude-code'
import { CANDIDATE_GAP_MS, candidateRank, hostChangeIn, successorFor } from '../protocol/handover'
import { githubRepo, loginKey, originOf } from '../protocol/join'
import { isHostProof } from '../protocol/seal'
import { parseStatus } from '../protocol/status'
import type { ImportRoomRequest, Member, Room } from '../protocol/types'
import type { RoomView } from '../types'
import { askHostProof, client, isNameNotFound } from './api'
import { findRoom } from './directory'
import type { DirectoryEntry } from './directory'
import { checkHost } from './hostcheck'
import { handOverHosting, rehostRoom } from './hosting'
import { rejoin } from './joining'
import { describe, inBackground, randomKey, runIfThere } from './processes'
import { getRoomView, getSync, loadSaved, saveSaved, setHandover, setRoomView } from './state'
import type { Saved } from './state'
import { enqueue, forgetRoom, pauseSync, refresh, sentAfter, startSync } from './sync'

const FOLLOW_EVERY_MS = 5_000
// How long a session looks for its room's new host before it gives up.
const FOLLOW_FOR_MS = 5 * 60_000
// A planned handover's successor goes first; the other candidates wait this
// long before their own turns, in case it cannot host after all.
const PLANNED_HEAD_START_MS = 90_000
// How long a room that was handed over keeps answering, so every member's
// long-poll hears the handover.
export const HANDOVER_GRACE_MS = 1_500

// The move under way, if any: one at a time.
let moving: { roomId: string; isStopped: boolean } | undefined

export const isMoving = () => moving !== undefined && !moving.isStopped

export function stopMoving(): void {
  if (moving !== undefined) moving.isStopped = true
  moving = undefined
}

// --- proving and moving -------------------------------------------------------------

// Whether the room host at `address` holds the room's secret: asked with a nonce
// of this session's, for the address as this session dials it.
export async function provesRoom($: EngineInterface, address: string, roomId: string, secret: string): Promise<boolean> {
  const challenge = { roomId, origin: originOf(address), nonce: randomKey() }
  try {
    const { proof } = await askHostProof($, address, challenge)
    return await isHostProof(secret, challenge, proof)
  } catch {
    return false
  }
}

// After a move to a new room host: what this session sent the old one that the
// new one's log does not hold, sent again, in order.
async function resendAfterMove($: EngineInterface): Promise<void> {
  await refresh($)
  const change = (await getRoomView($))?.log.map(hostChangeIn).find(found => found !== null)
  if (change == null) return
  const lost = sentAfter(change.importedUpTo)
  for (const body of lost) await enqueue($, { kind: 'say', body })
  if (lost.length > 0) await refresh($)
}

// This session, in its room at the room host at `address` (which proved
// itself), joined again on its SSH signature. Its session token never goes to
// a new address, not even when the room host there is the same one (a quick
// tunnel's new name): every member holds the room's secret, so a proof shows
// the room host is the room's, not that it is not a member's imitation of it;
// a signature bound to that address and its nonce is worth nothing elsewhere.
export async function rejoinAt(
  $: EngineInterface,
  saved: Saved,
  address: string,
  who: { from: string; to: string | null },
): Promise<'joined' | 'pending'> {
  pauseSync()
  await setHandover($, { phase: 'joining', from: who.from, to: who.to, isPlanned: true, turnAt: null, note: `joining the room at ${address}` })
  // A new room host numbers on from its own mirror: the view starts afresh.
  await setRoomView($, null)
  const outcome = await rejoin($, { roomId: saved.roomId, address, roomKey: saved.roomKey ?? null }, { roomMode: saved.roomMode, roomSecret: saved.roomSecret })
  await setHandover($, null)
  if (outcome === 'joined') inBackground($, resendAfterMove($))
  return outcome
}

// --- can this machine take over? (Q7) ----------------------------------------------

export const sameRepo = (a: string | null, b: string | null) => {
  const left = githubRepo(a)
  const right = githubRepo(b)
  return left !== null && right !== null && left.owner.toLowerCase() === right.owner.toLowerCase() && left.name.toLowerCase() === right.name.toLowerCase()
}

// Whether this session's folder is a clone of the room's repo (D22); true for
// a room without one.
async function isRoomRepo($: EngineInterface, room: Room): Promise<boolean> {
  if (room.repoUrl === null) return true
  const origin = await runIfThere($, ['git', 'remote', 'get-url', 'origin'], { cwd: await $.session.root() }).catch(() => null)
  return origin?.exitCode === 0 && sameRepo(origin.stdout.trim(), room.repoUrl)
}

// Node 24 and the room host's files, a way to be reached from elsewhere (not
// the LAN alone), the room's secret (and key, for a private room), and for a
// room with a repo, a clone of that repo here: its directory is where the
// others look for the new host.
export async function canHostHere($: EngineInterface, room: Room, saved: Saved, isInRepo?: boolean): Promise<boolean> {
  if (saved.roomSecret === undefined) return false
  if (room.visibility === 'private' && (saved.roomKey ?? null) === null) return false
  try {
    const { providers } = await checkHost($, { via: 'auto' })
    if (!providers.some(provider => provider !== 'lan')) return false
  } catch {
    return false
  }
  return isInRepo ?? (await isRoomRepo($, room))
}

// Once per session and room: tells the room host what this machine can do,
// and the person when this folder is not the room's repo (its tasks run only
// in a clone of it, runs.ts).
const reported = new Set<string>()

export async function reportCanHost($: EngineInterface, saved: Saved, room: Room): Promise<void> {
  const key = `${saved.roomId}/${saved.token}`
  if (reported.has(key) || saved.roomSecret === undefined) return
  reported.add(key)
  const isInRepo = await isRoomRepo($, room)
  if (!isInRepo) {
    $.ui.log(`Studio: this folder is not a clone of ${room.repoUrl}, the room's repo: you can talk in the room here, but its tasks run only in a clone of it.`)
  }
  const canHost = await canHostHere($, room, saved, isInRepo)
  await client($, saved).report({ canHost }).catch(() => undefined)
}

// --- the host leaves --------------------------------------------------------------------

// Why nobody can take over, for the person who wants to leave.
export function whyNobody(members: readonly Member[], hostLogin: string): string {
  const reasons = members
    .filter(member => member.login !== hostLogin)
    .map(member => {
      if (!member.verified) return `${member.login} is not verified`
      if (member.canHost === false) return `${member.login}'s machine cannot host`
      return `${member.login} is not online`
    })
  return reasons.join(', ')
}

// The host leaves with others still in the room: the room goes to the first
// successor who is here. `graceMs`: how long the room host keeps answering (at
// the end of a session the engine ends it). null when nobody can take over.
export async function leaveAsHost($: EngineInterface, graceMs: number | null): Promise<string | null> {
  const view = await getRoomView($)
  const saved = await loadSaved($)
  if (view === null || saved?.isHost !== true) return null
  const successor = successorFor(view.members, view.room.hostLogin)
  if (successor === null) return null
  await handOverHosting($, successor.login, graceMs)
  return successor.login
}

// --- members: the room moves ----------------------------------------------------------

type Plan = {
  roomId: string
  from: string
  to: string | null
  isPlanned: boolean
  // The address the room was at: any other one in the directory is news.
  oldAddress: string
  turnAt: number | null
  until: number
}

// The mirror, as the new room host takes it.
function mirrorRequest(view: RoomView, saved: Saved, plan: Plan): ImportRoomRequest | null {
  if (saved.roomSecret === undefined) return null
  const log = [...view.log].sort((a, b) => a.seq - b.seq)
  const last = log.at(-1)?.seq ?? 0
  const status = parseStatus(view.statusText)
  const state = view.state ?? { version: 0, coordinatorCursor: last, goals: [], decisions: [], questions: [], asks: [], debounceMs: 4000 }
  return {
    room: view.room,
    hostLogin: loginKey(saved.login),
    from: plan.from,
    reason: plan.isPlanned ? `${plan.from} left` : `${plan.from}'s machine stopped answering`,
    hasLeft: plan.isPlanned,
    roomSecret: saved.roomSecret,
    roomKey: saved.roomKey ?? null,
    members: view.members.map(({ login, role, verified, joinedAt }) => ({ login, role, verified, joinedAt })),
    tasks: view.tasks,
    // The cursor never past what was carried over.
    state: { ...state, coordinatorCursor: Math.min(state.coordinatorCursor, last) },
    status: { doing: status.doing, decided: status.decided, planned: status.planned, blocked: status.blocked },
    log,
  }
}

async function takeOver(
  $: EngineInterface,
  plan: Plan,
  view: RoomView,
  saved: Saved,
  expected: DirectoryEntry | null,
): Promise<'hosting' | 'cannot'> {
  const request = mirrorRequest(view, saved, plan)
  if (request === null) return 'cannot'
  await setHandover($, { phase: 'hosting', from: plan.from, to: saved.login, isPlanned: plan.isPlanned, turnAt: null, note: 'starting a room host from what this session saw of the room' })
  try {
    await rehostRoom($, request, {
      keep: { roomMode: saved.roomMode, roomSecret: saved.roomSecret },
      // A host that vanished: another candidate may get there first.
      claim: plan.isPlanned
        ? null
        : {
            expected,
            onTaken: () => {
              $.ui.toast('Studio: someone else took over hosting first: following the room there')
              inBackground($, start($, { from: plan.from, to: null, isPlanned: false, mayHost: false }))
            },
          },
    })
  } catch (error) {
    await setHandover($, { phase: 'waiting', from: plan.from, to: plan.to, isPlanned: plan.isPlanned, turnAt: null, note: `could not take over hosting: ${describe(error)}` })
    return 'cannot'
  }
  moving = undefined
  await setHandover($, null)
  $.ui.toast(`Studio: you host ${view.room.name} now`)
  $.ui.log(`Studio: you host ${view.room.name} now (${request.reason}); the others follow it here.`)
  const lost = sentAfter(request.log.at(-1)?.seq ?? 0)
  for (const body of lost) await enqueue($, { kind: 'say', body })
  if (lost.length > 0) inBackground($, refresh($))
  return 'hosting'
}

// Whether the old room host answers this session again (a blip longer than
// HOST_LOST_MS): then nothing moved.
async function answersAgain($: EngineInterface, saved: Saved): Promise<boolean> {
  try {
    await client($, saved).me()
    return true
  } catch {
    return false
  }
}

async function follow($: EngineInterface, mine: { roomId: string; isStopped: boolean }, plan: Plan, view: RoomView, saved: Saved): Promise<void> {
  const cwd = await $.session.root()
  const canFollow = view.room.repoUrl !== null && saved.roomSecret !== undefined
  let expected: DirectoryEntry | null = null
  let lastNote = ''
  const say = async (note: string) => {
    if (note === lastNote) return
    lastNote = note
    await setHandover($, { phase: 'waiting', from: plan.from, to: plan.to, isPlanned: plan.isPlanned, turnAt: plan.turnAt, note })
  }
  await say(plan.to === null ? 'waiting for someone to take over hosting' : `waiting for ${plan.to} to take over hosting`)

  for (let isFirst = true; !mine.isStopped; isFirst = false) {
    if (!isFirst) await $.clock.sleep(FOLLOW_EVERY_MS)
    if (mine.isStopped) return

    if (canFollow) {
      const found = await findRoom($, cwd, plan.roomId, saved.roomKey ?? null).catch(async error => {
        await say(`cannot read the room directory (${describe(error)})`)
        return null
      })
      if (found !== null) expected = found.entry
      const listing = found?.listing ?? null
      if (listing !== null && listing.address !== plan.oldAddress && saved.roomSecret !== undefined) {
        if (await provesRoom($, listing.address, plan.roomId, saved.roomSecret)) {
          try {
            await rejoinAt($, saved, listing.address, { from: plan.from, to: listing.host })
            moving = undefined
            $.ui.toast(`Studio: ${view.room.name} is hosted by ${listing.host} now`)
            return
          } catch (error) {
            // A new tunnel's name may not resolve yet: the next round tries again.
            if (!isNameNotFound(error)) await say(`could not join ${listing.host}'s room host yet (${describe(error)})`)
          }
        } else {
          await say(`the directory lists the room at ${listing.address}, which could not prove it hosts it`)
        }
      }
    }

    if (!plan.isPlanned && (await answersAgain($, saved))) {
      moving = undefined
      await setHandover($, null)
      startSync($)
      return
    }

    const now = await $.clock.now()
    if (plan.turnAt !== null && now >= plan.turnAt) {
      if ((await takeOver($, plan, view, saved, expected)) === 'hosting') return
      plan.turnAt = null
    }

    if (now >= plan.until) {
      moving = undefined
      await setHandover($, null)
      await forgetRoom($)
      const why = canFollow ? 'nobody took over hosting' : 'this room has no repo directory to find its new host in: ask for a new invite link'
      $.ui.toast(`Studio: ${view.room.name} is lost: ${why}`)
      return
    }
    if (!canFollow && plan.turnAt === null) await say(`${plan.to ?? 'the new host'} will have a new invite link: this room has no repo directory to find it in`)
  }
}

// Starts following the room: `mayHost`, this session takes its turn as a candidate.
async function start(
  $: EngineInterface,
  how: { from: string; to: string | null; isPlanned: boolean; mayHost: boolean },
): Promise<void> {
  const view = await getRoomView($)
  const saved = await loadSaved($)
  if (view === null || saved === null || view.room.id !== saved.roomId || isMoving()) return
  const mine = { roomId: saved.roomId, isStopped: false }
  moving = mine
  pauseSync()
  const me = loginKey(saved.login)
  const now = await $.clock.now()
  let turnAt: number | null = null
  if (how.mayHost && (await canHostHere($, view.room, saved))) {
    if (how.isPlanned && how.to === me) turnAt = now
    else {
      const rank = candidateRank(view.members, view.room.hostLogin, me)
      if (rank !== null) turnAt = now + (how.isPlanned ? PLANNED_HEAD_START_MS : 0) + rank * CANDIDATE_GAP_MS
    }
  }
  const plan: Plan = {
    roomId: saved.roomId,
    from: how.from,
    to: how.to,
    isPlanned: how.isPlanned,
    oldAddress: saved.hostUrl,
    turnAt,
    until: now + FOLLOW_FOR_MS + (how.isPlanned ? PLANNED_HEAD_START_MS : 0),
  }
  inBackground($, follow($, mine, plan, view, saved))
}

// The room's log said the host hands the room over (sync.ts, on the entry).
export function onHandover($: EngineInterface, saved: Saved, handover: { from: string; to: string }): void {
  if (saved.isHost === true || isMoving()) return
  inBackground($, start($, { ...handover, isPlanned: true, mayHost: true }))
}

// The room host has not answered for HOST_LOST_MS (sync.ts).
export function onHostLost($: EngineInterface, saved: Saved, hostLogin: string): void {
  if (saved.isHost === true || isMoving()) return
  inBackground($, start($, { from: hostLogin, to: null, isPlanned: false, mayHost: true }))
}

// Whether this session would look for the room elsewhere when its host goes
// quiet: only with a directory to look in and the secret to check what it finds.
export async function canFollowRoom($: EngineInterface): Promise<boolean> {
  const view = await getRoomView($)
  const saved = await loadSaved($)
  const state = await getSync($)
  return view !== null && saved !== null && view.room.repoUrl !== null && saved.roomSecret !== undefined && state.lastOkAt !== null
}
