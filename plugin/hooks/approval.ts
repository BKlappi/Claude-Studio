import { COORDINATOR } from '../protocol/coordinator'
import type { Task } from '../protocol/types'
import type { RunChoice } from '../types'

// A task shaped by anyone's words but this person's always asks before it runs
// on this machine (PLAN.md D23): someone else made it, someone else's request
// was merged into it, or the coordinator wrote it from the room's messages.
// The card shows while the person has claimed it and not answered.
export function isFromOthers(task: Task, login: string): boolean {
  return task.createdBy !== login || (task.askedBy ?? []).some(asker => asker !== login)
}

export function needsApproval(task: Task, login: string | null, approvals: Readonly<Record<string, RunChoice>>): boolean {
  return login !== null && task.state === 'claimed' && task.claimedBy === login && isFromOthers(task, login) && approvals[task.id] === undefined
}

// Whose words a task carries, for its card: "ben's task", "the coordinator's
// task (asked by ana, ben)".
export function originText(task: Task): string {
  const askers = (task.askedBy ?? []).join(', ')
  if (task.createdBy === COORDINATOR) return `the coordinator's task${askers === '' ? '' : ` (asked by ${askers})`}`
  const others = (task.askedBy ?? []).filter(asker => asker !== task.createdBy)
  return `${task.createdBy}'s task${others.length === 0 ? '' : ` (with ${others.join(', ')}'s requests)`}`
}

// The tasks whose answer is still worth keeping: this person's own, not done.
export function runnableIds(tasks: readonly Task[], login: string | null): string[] {
  return tasks.filter(task => login !== null && task.claimedBy === login && (task.state === 'claimed' || task.state === 'blocked')).map(task => task.id)
}
