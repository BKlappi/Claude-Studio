import { FAILS_PER_SLOT, slotAbove, slotOf } from '../protocol/planning'
import type { Task } from '../protocol/types'
import type { BatchView, HandoverView, HostingView, RoomView, SyncState } from '../types'

const HOSTING_WORDS: Record<HostingView['phase'], string> = {
  starting: 'starting the room host',
  exposing: 'making the room reachable',
  resolving: 'making the room reachable',
  up: 'online',
  restarting: 'restarting the room host',
  lost: 'room lost',
}

// Whether the room can be used right now, in a few words: the band and the
// status line say it.
export function connectionText(sync: SyncState, hosting: HostingView | null): string {
  const parts = [hosting !== null && hosting.phase !== 'up' ? HOSTING_WORDS[hosting.phase] : sync.failures > 0 ? 'reconnecting' : 'online']
  if (sync.queued > 0) parts.push(`${sync.queued} queued`)
  return parts.join(' · ')
}

// Where what the person types goes (PLAN.md D21): the band, the pane and the
// status line say it, since it decides who reads a prompt.
export const modeText = (isRoomMode: boolean): string => (isRoomMode ? 'prompts go to the room' : 'prompts stay local')

export type BandFacts = {
  sync: SyncState
  hosting: HostingView | null
  // People waiting for the host person to let them in.
  waiting: number
  // Tasks from someone else that this person claimed and has not answered yet (D23).
  toApprove: number
  isRoomMode: boolean
}

// `frontend · prompts go to the room · 3 open · you: 1 claimed`, then what is
// not as it should be.
export function bandText(view: RoomView, login: string | null, facts: BandFacts): string {
  const open = view.tasks.filter(task => task.state === 'open').length
  const mine = login === null ? 0 : view.tasks.filter(task => task.state === 'claimed' && task.claimedBy === login).length
  const parts = [view.room.name, modeText(facts.isRoomMode), `${open} open`]
  if (mine > 0) parts.push(`you: ${mine} claimed`)
  if (facts.toApprove > 0) parts.push(`${facts.toApprove} to approve`)
  const connection = connectionText(facts.sync, facts.hosting)
  if (connection !== 'online') parts.push(connection)
  if (facts.waiting > 0) parts.push(`${facts.waiting} waiting to be let in`)
  return parts.join(' · ')
}

// The room moving to another host (PLAN.md §5), in one line: what happened,
// and what this session is doing about it.
export function handoverText(handover: HandoverView, now: number): string {
  const what = handover.isPlanned
    ? `${handover.from} left${handover.to === null ? '' : `: ${handover.to} takes over hosting`}`
    : `${handover.from}'s machine stopped answering`
  switch (handover.phase) {
    case 'hosting': return `${what}: you take over hosting · ${handover.note}`
    case 'joining': return `${what} · ${handover.note}`
    case 'failed': return `${what} · ${handover.note}`
    case 'waiting': {
      const turn = handover.turnAt === null ? '' : handover.turnAt > now ? ` · you take over in ${Math.ceil((handover.turnAt - now) / 1000)} s if nobody has` : ' · your turn to take over'
      return `${what} · ${handover.note}${turn}`
    }
  }
}

// "coordinator reads in 3 s…" while the batching window is open (PLAN.md §5).
// The window was `closesInMs` long when the room host answered, which this
// side heard at `lastOkAt`; `now` is this side's clock too, so no two clocks meet.
export function countdownText(batch: BatchView | null, lastOkAt: number | null, now: number): string | null {
  if (batch === null || lastOkAt === null) return null
  const left = batch.closesInMs - (now - lastOkAt)
  return left > 0 ? `coordinator reads in ${Math.ceil(left / 1000)} s…` : 'coordinator is reading…'
}

// The model slot a task's next run takes, for the pane: `medium`; `easy→medium`
// once reviews moved it up; `to plan (hard)` for a task that is split into
// subtasks first; and the reviewed runs it has had (PLAN.md phase 4).
export function slotText(task: Task): string {
  if (task.needsPlan === true) return 'to plan (hard)'
  const slot = slotOf(task)
  const label = task.difficulty !== null && task.difficulty !== slot ? `${task.difficulty}→${slot}` : slot
  const runs = task.attempts ?? 0
  return runs === 0 ? label : `${label} · ${runs} ${runs === 1 ? 'run' : 'runs'}`
}

// What a task's open view adds under its spec: where it came from, what done
// looks like, and how its reviews stand. `parent`: the task it was planned out of.
export function detailLines(task: Task, parent: Task | undefined): string[] {
  const lines: string[] = []
  if (task.parentId != null) lines.push(`part of "${parent?.title ?? 'a plan'}"`)
  if (task.needsPlan === true) lines.push("needs a plan: whoever claims it has Studio's planner split it into subtasks")
  const checks = task.checks ?? []
  if (checks.length > 0) lines.push('done when:', ...checks.map(check => `- ${check}`))
  const review = task.review
  if (review != null) {
    lines.push(`last review: ${review.verdict} (${review.slot} model, by ${review.by})${review.reasons.length === 0 ? '' : `: ${review.reasons.join('; ')}`}`)
  }
  const failed = task.failedReviews ?? 0
  if (failed > 0 && task.state !== 'done') {
    const slot = slotOf(task)
    const above = slotAbove(slot)
    lines.push(`${failed} of ${FAILS_PER_SLOT} reviews failed on the ${slot} model: ${above === null ? 'one more blocks it' : `one more moves it to ${above}`}`)
  }
  return lines
}
