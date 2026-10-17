import type { CreateTaskRequest, Task, TaskState } from '../../plugin/protocol/types.ts'
import type { Db } from './db/index.ts'
import { appendLog } from './log.ts'
import { TASK_COLUMNS, isAdmin, openRoom } from './rooms.ts'
import type { Caller } from './rooms.ts'
import { fail, newId, now } from './util.ts'

// A task is reachable only through the caller's own room.
function taskFor(db: Db, caller: Caller, taskId: string): Task {
  const task = db.one<Task>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ? AND room_id = ?`, taskId, caller.roomId)
  return task ?? fail(404, 'no such task')
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
      createdAt: at,
      updatedAt: at,
      version: 1,
    }
    db.run(
      `INSERT INTO tasks (id, room_id, title, spec, state, difficulty, claimed_by, created_by, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id, task.roomId, task.title, task.spec, task.state, task.difficulty, task.claimedBy,
      task.createdBy, task.createdAt, task.updatedAt, task.version,
    )
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
