import { afterReview, checkPlan, checkReview, describePlan, describeReview, slotOf } from '../../protocol/planning.ts'
import type {
  CreateTaskRequest,
  LogEntry,
  Task,
  TaskPlanRequest,
  TaskPlanResponse,
  TaskResultRequest,
  TaskReview,
  TaskReviewRequest,
  TaskReviewResponse,
  TaskState,
} from '../../protocol/types.ts'
import type { Db } from './db/index.ts'
import { appendLog } from './log.ts'
import { TASK_COLUMNS, isAdmin, openRoom, toTask } from './rooms.ts'
import type { Caller, TaskRow } from './rooms.ts'
import { fail, newId, now } from './util.ts'

// A task of the room, if it has one by that id.
export function findTask(db: Db, roomId: string, taskId: string): Task | undefined {
  const row = db.one<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ? AND room_id = ?`, taskId, roomId)
  return row === undefined ? undefined : toTask(row)
}

// A task is reachable only through the caller's own room.
function taskFor(db: Db, caller: Caller, taskId: string): Task {
  return findTask(db, caller.roomId, taskId) ?? fail(404, 'no such task')
}

// Writes a new task (its log entry is the caller's to write). Phase 4's fields
// may be absent: a successor's mirror of a room host from before has none.
export function insertTask(db: Db, task: Task): void {
  db.run(
    `INSERT INTO tasks (id, room_id, title, spec, state, difficulty, claimed_by, created_by, asked_by, created_at, updated_at, version,
                        needs_plan, parent_id, checks, slot, attempts, failed_reviews, last_review)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    task.id, task.roomId, task.title, task.spec, task.state, task.difficulty, task.claimedBy,
    task.createdBy, JSON.stringify(task.askedBy), task.createdAt, task.updatedAt, task.version,
    task.needsPlan === true ? 1 : 0, task.parentId ?? null, JSON.stringify(task.checks ?? []), task.slot ?? null,
    task.attempts ?? 0, task.failedReviews ?? 0, task.review == null ? null : JSON.stringify(task.review),
  )
}

export function createTask(db: Db, caller: Caller, input: CreateTaskRequest): Task {
  return db.tx(() => {
    const room = openRoom(db, caller.roomId)
    const title = input.title.trim()
    if (title === '') fail(400, 'task needs a title')

    const at = now()
    const task: Task = {
      id: newId(),
      roomId: room.id,
      title,
      spec: input.spec ?? '',
      state: 'open',
      difficulty: input.difficulty ?? null,
      claimedBy: null,
      createdBy: caller.login,
      askedBy: [caller.login],
      createdAt: at,
      updatedAt: at,
      version: 1,
      // Easy work is one file: it is never planned (protocol/coordinator.ts).
      needsPlan: input.needsPlan === true && input.difficulty !== 'easy',
    }
    insertTask(db, task)
    appendLog(db, room.id, 'task', caller.login, `task added: ${title}`, { taskId: task.id, change: 'created' })
    return task
  })
}

export function claimTask(db: Db, caller: Caller, taskId: string): Task {
  return db.tx(() => {
    const task = taskFor(db, caller, taskId)
    const { changes } = db.run(
      `UPDATE tasks SET state = 'claimed', claimed_by = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND state = 'open'`,
      caller.login, now(), task.id,
    )
    if (changes === 0) fail(409, 'task is not open')
    appendLog(db, task.roomId, 'task', caller.login, `${caller.login} claimed: ${task.title}`, { taskId, change: 'claimed' })
    return taskFor(db, caller, taskId)
  })
}

// Back to the task map: a member let go, or hit their usage limit.
export function releaseTask(db: Db, caller: Caller, taskId: string, reason?: string): Task {
  return db.tx(() => {
    const task = taskFor(db, caller, taskId)
    if (task.claimedBy !== caller.login && !isAdmin(caller.role)) fail(403, 'only the claimer can release a task')
    if (task.state !== 'claimed') fail(409, 'task is not claimed')

    db.run(
      `UPDATE tasks SET state = 'open', claimed_by = NULL, version = version + 1, updated_at = ? WHERE id = ?`,
      now(), task.id,
    )
    const why = reason === undefined ? '' : ` (${reason})`
    appendLog(db, task.roomId, 'task', caller.login, `back on the map: ${task.title}${why}`, { taskId, change: 'released', reason })
    return taskFor(db, caller, taskId)
  })
}

// How a run of the task went on the claimer's machine (PLAN.md phase 3): its
// report goes in the log for the room; the claimer then marks it done or blocked.
export function postResult(db: Db, caller: Caller, taskId: string, input: TaskResultRequest): LogEntry {
  return db.tx(() => {
    const task = taskFor(db, caller, taskId)
    if (task.claimedBy !== caller.login) fail(403, 'only the claimer reports how a run of the task went')
    const summary = input.summary.trim()
    const first = (summary.split('\n').map(text => text.trim()).find(Boolean) ?? '').slice(0, 200)
    const body = `${caller.login}'s run of "${task.title}" ${input.isFinished ? 'finished' : 'stopped'}${first === '' ? '' : `: ${first}`}`
    return appendLog(db, task.roomId, 'task', caller.login, body, {
      taskId,
      change: 'result',
      isFinished: input.isFinished,
      branch: input.branch ?? null,
      summary,
    })
  })
}

// A needsPlan task's plan, from its claimer (PLAN.md phase 4): the subtasks
// go on the map, open, labeled, with their checks, and the task is done: it
// lives on in them. Checked once more here: a plan is a model's answer to room
// text and to what it read in the claimer's checkout.
export function planTask(db: Db, caller: Caller, taskId: string, input: TaskPlanRequest): TaskPlanResponse {
  return db.tx(() => {
    const task = taskFor(db, caller, taskId)
    openRoom(db, task.roomId)
    if (task.claimedBy !== caller.login) fail(403, 'only the claimer hands in a plan of the task')
    if (task.needsPlan !== true) fail(409, 'the task needs no plan')
    if (task.state !== 'claimed') fail(409, `the task is ${task.state}: only a claimed task is planned`)
    const checked = checkPlan(input)
    if ('error' in checked) return fail(400, `no plan: ${checked.error}`)
    const { plan, dropped } = checked
    const at = now()
    // The subtasks carry the words the task carried and the planner's (it ran
    // on the claimer's machine): D23 asks first wherever they are not yours.
    const askedBy = [...new Set([...task.askedBy, caller.login])]
    const subtasks = plan.subtasks.map((subtask): Task => ({
      id: newId(),
      roomId: task.roomId,
      title: subtask.title,
      spec: subtask.spec,
      state: 'open',
      difficulty: subtask.difficulty,
      claimedBy: null,
      createdBy: task.createdBy,
      askedBy,
      createdAt: at,
      updatedAt: at,
      version: 1,
      parentId: task.id,
      checks: subtask.checks,
    }))
    for (const subtask of subtasks) insertTask(db, subtask)
    db.run(`UPDATE tasks SET state = 'done', needs_plan = 0, version = version + 1, updated_at = ? WHERE id = ?`, at, task.id)
    appendLog(db, task.roomId, 'task', caller.login, `${caller.login} ${describePlan(task.title, plan)}`, {
      taskId,
      change: 'planned',
      taskIds: subtasks.map(subtask => subtask.id),
      summary: plan.summary,
      dropped,
    })
    return { task: taskFor(db, caller, taskId), subtasks: subtasks.map(subtask => taskFor(db, caller, subtask.id)) }
  })
}

// The review of a run of the task, from its claimer (PLAN.md phase 4). The
// escalation rule (protocol/planning.ts afterReview) is applied here, so every
// member sees the task where it stands: tried again, a slot up, or blocked
// with the room asked what should change.
export function reviewTask(db: Db, caller: Caller, taskId: string, input: TaskReviewRequest): TaskReviewResponse {
  return db.tx(() => {
    const task = taskFor(db, caller, taskId)
    openRoom(db, task.roomId)
    if (task.claimedBy !== caller.login) fail(403, 'only the claimer reports how a run of the task was reviewed')
    if (task.state !== 'claimed') fail(409, `the task is ${task.state}: only a claimed task's run is reviewed`)
    if (task.needsPlan === true) fail(409, 'a plan is not reviewed')
    const slot = slotOf(task)
    if (input.slot !== slot) fail(409, `that run was on the ${input.slot} slot, the task is on ${slot} now`)
    const checked = checkReview(input)
    if ('error' in checked) return fail(400, checked.error)
    const { review } = checked
    const after = afterReview({ slot, failedReviews: task.failedReviews ?? 0 }, review.verdict)
    const attempt = (task.attempts ?? 0) + 1
    const record: TaskReview = { verdict: review.verdict, reasons: review.reasons, slot, by: caller.login, at: now() }
    db.run(
      `UPDATE tasks SET slot = ?, attempts = ?, failed_reviews = ?, last_review = ?, state = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      after.outcome === 'escalated' ? after.slot : (task.slot ?? null), attempt, after.failedReviews, JSON.stringify(record),
      after.outcome === 'blocked' ? 'blocked' : task.state, record.at, task.id,
    )
    appendLog(db, task.roomId, 'task', caller.login, describeReview(task.title, review, { slot, attempt }, after), {
      taskId,
      change: 'review',
      verdict: review.verdict,
      reasons: review.reasons,
      slot,
      attempt,
      outcome: after.outcome,
      nextSlot: after.slot,
    })
    return { task: taskFor(db, caller, taskId), outcome: after.outcome }
  })
}

export function setTaskState(db: Db, caller: Caller, taskId: string, state: TaskState, version: number): Task {
  return db.tx(() => {
    const task = taskFor(db, caller, taskId)
    const room = openRoom(db, task.roomId)
    const mayChange = task.claimedBy === caller.login || room.hostLogin === caller.login || isAdmin(caller.role)
    if (!mayChange) fail(403, 'only the claimer, the host or an admin changes a task')

    const claimedBy = state === 'open' ? null : task.claimedBy
    const { changes } = db.run(
      `UPDATE tasks SET state = ?, claimed_by = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
      state, claimedBy, now(), task.id, version,
    )
    if (changes === 0) fail(409, 'task changed meanwhile; reload and retry')
    appendLog(db, task.roomId, 'task', caller.login, `${task.title}: ${task.state} → ${state}`, { taskId, change: 'state', state })
    return taskFor(db, caller, taskId)
  })
}
