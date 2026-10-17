// The joiner's side of the handshake (room-host/src/joins.ts has the host's):
// nonce, signature, join; then, when it takes longer than one command, a
// loop in the background with the pane saying how it goes.
//
//   - the address does not resolve yet (a new tunnel; a resolver that cached
//     "no such name"): try again every 5 s for 90 s (PLAN.md §9)
//   - the host person decides (no proof, or no permission answer): poll the
//     ticket every 2 s while the host keeps the request (10 min)

import type { EngineInterface } from 'claude-code'
import { joinMessage } from '../protocol/join'
import type { Invite } from '../protocol/join'
import type { JoinAdmitted } from '../protocol/types'
import { StudioError, isNameNotFound, joinClient } from './api'
import { PANE_ID } from './commands'
import { linkIdentity, signJoin } from './identity'
import { describe, inBackground } from './processes'
import { loadIdentity, saveSaved, setAccount, setJoining } from './state'
import type { Identity } from './state'
import { startSync } from './sync'

export const RESOLVE_FOR_MS = 90_000
const RESOLVE_EVERY_MS = 5_000
const TICKET_EVERY_MS = 2_000
const TICKET_FOR_MS = 10 * 60_000

// A newer join (or /room leave) ends the background loop of an older one.
let attempt = 0

export function cancelJoining($: EngineInterface): Promise<unknown> {
  attempt += 1
  return setJoining($, null)
}

type Step = { kind: 'joined'; admitted: JoinAdmitted } | { kind: 'pending'; ticket: string; reason: string }

async function enterRoom($: EngineInterface, invite: Invite, admitted: JoinAdmitted): Promise<void> {
  await saveSaved($, {
    hostUrl: invite.address,
    roomId: admitted.room.id,
    token: admitted.token,
    login: admitted.login,
    roomKey: invite.roomKey,
  })
  await setAccount($, { login: admitted.login, role: admitted.role, hostUrl: invite.address })
  await setJoining($, null)
  startSync($)
  inBackground($, $.ui.open({ id: PANE_ID, title: `room: ${admitted.room.name}` }))
}

async function joinOnce($: EngineInterface, invite: Invite, identity: Identity): Promise<Step> {
  const api = joinClient($, invite.address)
  const { nonce } = await api.nonce(invite.roomId)
  let signature: string | null = null
  // What the host person reads: no paths or names from this machine.
  let noProof = 'no SSH key GitHub lists for me is usable here'
  if (identity.keyFile !== null) {
    try {
      signature = await signJoin($, identity.keyFile, joinMessage({ roomId: invite.roomId, origin: invite.address, login: identity.login, nonce }))
    } catch {
      noProof = 'ssh-keygen could not sign with my key'
    }
  }
  const answer = await api.join({
    roomId: invite.roomId,
    origin: invite.address,
    login: identity.login,
    nonce,
    signature,
    noProof: signature === null ? noProof.slice(0, 200) : undefined,
    roomKey: invite.roomKey ?? undefined,
  })
  if (answer.status === 'pending') return { kind: 'pending', ticket: answer.ticket, reason: answer.reason }
  await enterRoom($, invite, answer)
  return { kind: 'joined', admitted: answer }
}

const joinedText = (admitted: JoinAdmitted) =>
  `Joined ${admitted.room.name}, hosted by ${admitted.room.hostLogin}${admitted.verified ? '' : ' (let in by hand: unverified)'}.`

async function fail($: EngineInterface, address: string, why: string): Promise<void> {
  await setJoining($, { phase: 'failed', address, note: why })
  $.ui.toast(`Studio: could not join: ${why}`)
}

async function waitForHost($: EngineInterface, invite: Invite, ticket: string, reason: string, run: number): Promise<void> {
  await setJoining($, { phase: 'waiting', address: invite.address, note: reason })
  const api = joinClient($, invite.address)
  const until = (await $.clock.now()) + TICKET_FOR_MS
  while (attempt === run && (await $.clock.now()) < until) {
    await $.clock.sleep(TICKET_EVERY_MS)
    if (attempt !== run) return
    let answer
    try {
      answer = await api.ticket(ticket)
    } catch (error) {
      // Unreachable for a moment: keep asking. Gone or refused: stop.
      if (error instanceof StudioError && error.status !== 0) return fail($, invite.address, error.message)
      continue
    }
    if (answer.status === 'pending') continue
    if (answer.status === 'refused') return fail($, invite.address, answer.reason)
    await enterRoom($, invite, answer)
    $.ui.toast(`Studio: ${joinedText(answer)}`)
    $.ui.log(`Studio: ${joinedText(answer)}`)
    return
  }
  if (attempt === run) await fail($, invite.address, 'the host did not answer in 10 minutes')
}

async function retryWhileResolving($: EngineInterface, invite: Invite, identity: Identity, run: number): Promise<void> {
  await setJoining($, { phase: 'resolving', address: invite.address, note: 'the address does not resolve yet' })
  const until = (await $.clock.now()) + RESOLVE_FOR_MS
  while (attempt === run) {
    await $.clock.sleep(RESOLVE_EVERY_MS)
    if (attempt !== run) return
    try {
      const step = await joinOnce($, invite, identity)
      if (step.kind === 'pending') return waitForHost($, invite, step.ticket, step.reason, run)
      $.ui.toast(`Studio: ${joinedText(step.admitted)}`)
      $.ui.log(`Studio: ${joinedText(step.admitted)}`)
      return
    } catch (error) {
      if (!isNameNotFound(error)) return fail($, invite.address, describe(error))
      if ((await $.clock.now()) >= until) return fail($, invite.address, `${invite.address} did not resolve in 90 s`)
    }
  }
}

// /room join <link>: one try now; what takes longer goes on in the background.
export async function joinRoom($: EngineInterface, invite: Invite): Promise<string> {
  const identity = (await loadIdentity($)) ?? (await linkIdentity($))
  const run = ++attempt
  await setJoining($, null)
  try {
    const step = await joinOnce($, invite, identity)
    if (step.kind === 'joined') return joinedText(step.admitted)
    inBackground($, waitForHost($, invite, step.ticket, step.reason, run))
    return `The host decides whether you get in: ${step.reason}. The room pane shows when they do.`
  } catch (error) {
    if (!isNameNotFound(error)) throw error
    inBackground($, retryWhileResolving($, invite, identity, run))
    return `${invite.address} does not resolve yet (a new tunnel's name takes up to a minute): trying again for 90 s.`
  }
}
