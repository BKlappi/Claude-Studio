// Who takes over hosting when the host leaves (PLAN.md §5, Q7). Pure and
// shared: every member reads the same snapshot, so every member's mod picks
// the same successor in the same order.

import type { LogEntry, Member } from './types.ts'

// Members notice an unplanned handover after this long without an answer.
export const HOST_LOST_MS = 30_000
// Candidates take their turn this far apart, in successor order.
export const CANDIDATE_GAP_MS = 15_000

// Verified members other than the host whose machine can host, longest in the
// room first (the members come in joining order). A member whose mod has not
// said (a mod from before phase 3) counts as one that can.
export function successors(members: readonly Member[], hostLogin: string): Member[] {
  return members.filter(member => member.login !== hostLogin && member.verified && member.canHost !== false)
}

// The successor for a planned handover: the first who is here now.
export function successorFor(members: readonly Member[], hostLogin: string): Member | null {
  return successors(members, hostLogin).find(member => member.isOnline) ?? null
}

// This member's turn among the candidates of an unplanned handover (0 is
// first), or null when they are none: the ones who were here when the host
// was last heard from, in successor order.
export function candidateRank(members: readonly Member[], hostLogin: string, login: string): number | null {
  const rank = successors(members, hostLogin).filter(member => member.isOnline).findIndex(member => member.login === login)
  return rank === -1 ? null : rank
}

const dataOf = (entry: LogEntry) => (typeof entry.data === 'object' && entry.data !== null ? (entry.data as Record<string, unknown>) : {})

// The planned handover a log entry announces, if it is one the room host wrote.
export function handoverIn(entry: LogEntry): { from: string; to: string } | null {
  const data = dataOf(entry)
  if (entry.kind !== 'system' || data.change !== 'handover' || typeof data.from !== 'string' || typeof data.to !== 'string') return null
  return { from: data.from, to: data.to }
}

// The first entry of a room host that took over: up to which seq it carried the log on.
export function hostChangeIn(entry: LogEntry): { host: string; importedUpTo: number } | null {
  const data = dataOf(entry)
  if (entry.kind !== 'system' || data.change !== 'host' || typeof data.host !== 'string' || typeof data.importedUpTo !== 'number') return null
  return { host: data.host, importedUpTo: data.importedUpTo }
}
