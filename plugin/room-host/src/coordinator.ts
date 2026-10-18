// The room host's side of the coordinator (protocol/coordinator.ts): it keeps
// the room state, decides when a batch is ready (the batching window, on its
// own clock), hands the batch to the host's mod, and applies the mod's actions
// in one transaction, only while nothing moved since the batch was read.
//
// The host's mod is the host person's own, and holds the host key; its actions
// are checked here once more anyway: they come from a model that read room text.

import { batchClosesAt, batchWindow, clampDebounce } from '../../protocol/batch.ts'
import { COORDINATOR, LIMITS, askersOf, checkActions, describeAction, describeStateChange } from '../../protocol/coordinator.ts'
import type { CommitResponse, CoordinatorAction, CoordinatorBatch, CoordinatorCommit, TaskDraft } from '../../protocol/coordinator.ts'
import type { Ask, BatchWindow, LogEntry, RoomState, Task } from '../../protocol/types.ts'
import type { Db } from './db/index.ts'
import { appendLog, latestSeq } from './log.ts'
import { isAdmin, membersOf, openRoom, tasksOf } from './rooms.ts'
import type { Caller, Presence } from './rooms.ts'
import { findTask, insertTask } from './tasks.ts'
import { fail, newId, now } from './util.ts'

// The spec of a task, merges included, stays under what the member route takes.
const MAX_SPEC = 20_000

type Doc = { goals: string[]; decisions: string[]; questions: string[]; asks: Ask[] }
type StateRow = { version: number; coordinatorCursor: number; doc: string; debounceMs: number }

function docOf(text: string): Doc {
  let doc: Partial<Doc> = {}
  try {
    doc = JSON.parse(text) as Partial<Doc>
  } catch {
    // Written by this host only.
  }
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  return { goals: list(doc.goals), decisions: list(doc.decisions), questions: list(doc.questions), asks: Array.isArray(doc.asks) ? doc.asks : [] }
}

export function roomState(db: Db, roomId: string): RoomState {
  const row = db.one<StateRow>(
    'SELECT version, coordinator_cursor AS coordinatorCursor, doc, debounce_ms AS debounceMs FROM room_state WHERE room_id = ?',
    roomId,
  )
  if (row === undefined) fail(404, 'no such room')
  const { doc, ...rest } = row as StateRow
  return { ...rest, ...docOf(doc) }
}

// Whether a coordinator reads a room now, in memory like presence: the host's
// mod asked for a batch in the last 30 s (its asking is a 25 s long-poll), or
// holds one it has not committed yet (a model call can take a minute or two).
// Members are shown the batching window only then: without a coordinator
// nothing would ever close it.
const SEEN_MS = 30_000
const READING_MS = 5 * 60_000

export function createCoordinatorWatch() {
  const rooms = new Map<string, { seenAt: number; readingSince: number | null }>()
  const of = (roomId: string) => rooms.get(roomId) ?? { seenAt: -Infinity, readingSince: null }
  return {
    seen: (roomId: string) => rooms.set(roomId, { ...of(roomId), seenAt: now() }),
    reading: (roomId: string) => rooms.set(roomId, { seenAt: now(), readingSince: now() }),
    done: (roomId: string) => rooms.set(roomId, { seenAt: now(), readingSince: null }),
    isActive: (roomId: string) => {
      const watched = of(roomId)
      return now() - watched.seenAt <= SEEN_MS || (watched.readingSince !== null && now() - watched.readingSince <= READING_MS)
    },
  }
}

// The members' messages after the cursor, oldest first: a batch's worth, by
// count and by length (one long message still makes a batch of one).
function unread(db: Db, roomId: string, cursor: number): LogEntry[] {
  const rows = db.all<Omit<LogEntry, 'data'>>(
    `SELECT seq, room_id AS roomId, kind, author, body, at FROM room_log
     WHERE room_id = ? AND seq > ? AND kind = 'message' AND author IS NOT NULL ORDER BY seq LIMIT ?`,
    roomId, cursor, LIMITS.batchMessages,
  )
  const batch: LogEntry[] = []
  let chars = 0
  for (const row of rows) {
    const length = Math.min(row.body.length, LIMITS.messageChars)
    if (batch.length > 0 && chars + length > LIMITS.batchChars) break
    batch.push({ ...row, data: null })
    chars += length
  }
  return batch
}

// When the waiting messages are read: null when none wait.
export function batchClosing(db: Db, roomId: string): number | null {
  const state = roomState(db, roomId)
  return batchClosesAt(unread(db, roomId, state.coordinatorCursor).map(entry => entry.at), state.debounceMs)
}

// The window as a member's snapshot carries it.
export function windowOf(db: Db, roomId: string): BatchWindow | null {
  const state = roomState(db, roomId)
  return batchWindow(unread(db, roomId, state.coordinatorCursor).map(entry => entry.at), now(), state.debounceMs)
}

// The batch the coordinator reads next, whether or not its window closed.
export function nextBatch(db: Db, roomId: string, presence: Presence): CoordinatorBatch | null {
  const room = openRoom(db, roomId)
  const state = roomState(db, roomId)
  const messages = unread(db, roomId, state.coordinatorCursor)
  const last = messages.at(-1)
  if (last === undefined) return null
  return {
    room,
    state,
    tasks: tasksOf(db, roomId),
    members: membersOf(db, roomId, presence),
    messages,
    fromSeq: state.coordinatorCursor,
    upToSeq: last.seq,
  }
}

// --- applying a commit ---------------------------------------------------------

const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])]

function newTask(roomId: string, draft: TaskDraft, askedBy: string[], at: number): Task {
  return {
    id: newId(),
    roomId,
    title: draft.title,
    spec: draft.spec,
    state: 'open',
    difficulty: draft.difficulty,
    claimedBy: null,
    createdBy: COORDINATOR,
    askedBy,
    createdAt: at,
    updatedAt: at,
    version: 1,
  }
}

// One checked action into the room; the log entry it wrote, or null when the
// room's tasks no longer allow it.
function apply(db: Db, roomId: string, action: CoordinatorAction, askers: string[], state: RoomState): LogEntry | null {
  const at = now()
  const data = (extra: object) => ({ action: action.type, ...('from' in action ? { from: action.from } : {}), askedBy: askers, ...extra })
  const log = (body: string, extra: object = {}) => appendLog(db, roomId, 'coordinator', null, body, data(extra))
  switch (action.type) {
    case 'createTask': {
      const task = { ...newTask(roomId, action, askers, at), needsPlan: action.needsPlan === true && action.difficulty !== 'easy' }
      insertTask(db, task)
      return log(describeAction(action, askers), { taskId: task.id })
    }
    case 'mergeIntoTask': {
      const task = findTask(db, roomId, action.taskId)
      if (task === undefined || task.state === 'done') return null
      const spec = action.addition === '' ? task.spec : `${task.spec.trim()}\n\n${action.addition}`.trim().slice(0, MAX_SPEC)
      // A new spec is new work for the reviews: its failed ones count no more
      // (protocol/planning.ts afterReview), and a blocked task may try again.
      db.run(
        `UPDATE tasks SET spec = ?, asked_by = ?, failed_reviews = CASE WHEN ? THEN 0 ELSE failed_reviews END,
                version = version + 1, updated_at = ? WHERE id = ?`,
        spec, JSON.stringify(union(task.askedBy, askers)), spec === task.spec ? 0 : 1, at, task.id,
      )
      return log(describeAction(action, askers, task.title), { taskId: task.id })
    }
    case 'splitTask': {
      const task = findTask(db, roomId, action.taskId)
      if (task === undefined || task.state !== 'open') return null
      const [first, ...rest] = action.parts
      if (first === undefined) return null
      // The first part is other work than the task was: its checks and where
      // its reviews stood go with the old scope.
      db.run(
        `UPDATE tasks SET title = ?, spec = ?, difficulty = ?, checks = '[]', slot = NULL, failed_reviews = 0,
                version = version + 1, updated_at = ? WHERE id = ?`,
        first.title, first.spec, first.difficulty, at, task.id,
      )
      // A subtask's parts are subtasks of the same plan.
      const added = rest.map(part => ({ ...newTask(roomId, part, task.askedBy, at), parentId: task.parentId ?? null }))
      for (const part of added) insertTask(db, part)
      return log(describeAction(action, task.askedBy, task.title), { taskId: task.id, taskIds: [task.id, ...added.map(part => part.id)] })
    }
    case 'reject':
      return log(describeAction(action, askers))
    case 'reply':
      return log(describeAction(action, askers))
    case 'updateState':
      return log(describeStateChange(state, action))
  }
}

// A batch's actions, applied once (PLAN.md §5): only while the cursor and the
// state's version are those the batch was read at. A commit that arrives
// twice, or after a newer one, is refused with 409 and changes nothing.
export function commitBatch(db: Db, roomId: string, commit: CoordinatorCommit): CommitResponse {
  return db.tx(() => {
    openRoom(db, roomId)
    const state = roomState(db, roomId)
    if (state.coordinatorCursor !== commit.fromSeq || state.version !== commit.baseVersion) {
      fail(409, 'the room moved on since this batch was read: read it again')
    }
    if (commit.upToSeq <= commit.fromSeq || commit.upToSeq > latestSeq(db, roomId)) {
      fail(400, 'upToSeq is not a seq after the cursor')
    }
    const messages = db.all<{ seq: number; author: string }>(
      `SELECT seq, author FROM room_log WHERE room_id = ? AND seq > ? AND seq <= ? AND kind = 'message' AND author IS NOT NULL`,
      roomId, commit.fromSeq, commit.upToSeq,
    )
    const authors = new Map(messages.map(message => [message.seq, message.author] as const))
    const members = db.all<{ login: string }>('SELECT login FROM room_members WHERE room_id = ? AND left_at IS NULL', roomId).map(row => row.login)
    const { actions, dropped } = checkActions({ actions: commit.actions }, { authors, tasks: tasksOf(db, roomId, { isAll: true }), members })

    let doc: Doc = { goals: state.goals, decisions: state.decisions, questions: state.questions, asks: state.asks }
    const entries: LogEntry[] = []
    for (const action of actions) {
      const askers = 'from' in action ? askersOf(action.from, authors) : []
      const entry = apply(db, roomId, action, askers, { ...state, ...doc })
      if (entry === null) {
        dropped.push(`${action.type}: the task changed meanwhile`)
        continue
      }
      entries.push(entry)
      if (action.type === 'updateState') {
        doc = {
          goals: action.goals ?? doc.goals,
          decisions: action.decisions ?? doc.decisions,
          questions: action.questions ?? doc.questions,
          asks: action.asks ?? doc.asks,
        }
      }
    }
    const allDropped = [...(commit.dropped ?? []).map(reason => String(reason).slice(0, 300)).slice(0, 20), ...dropped]
    // The commit's own entry: what was read, what it cost, what was left out
    // and why (PLAN.md §8, cost). The pane does not show it (`quiet`).
    const count = `${authors.size} ${authors.size === 1 ? 'message' : 'messages'}`
    appendLog(db, roomId, 'coordinator', null, allDropped.length === 0 ? `read ${count}` : `read ${count}; ${allDropped.length} of its actions left out`, {
      action: 'read',
      upToSeq: commit.upToSeq,
      dropped: allDropped,
      usage: commit.usage ?? null,
      quiet: true,
    })
    db.run(
      'UPDATE room_state SET version = version + 1, coordinator_cursor = ?, doc = ?, updated_at = ? WHERE room_id = ?',
      commit.upToSeq, JSON.stringify(doc), now(), roomId,
    )
    return { state: roomState(db, roomId), applied: entries.length, dropped: allDropped }
  })
}

// A line from the coordinator outside a commit: it cannot reach its model, say.
export function postNote(db: Db, roomId: string, body: string): LogEntry {
  openRoom(db, roomId)
  return appendLog(db, roomId, 'coordinator', null, body.trim().slice(0, 500), { action: 'note' })
}

// The room's batching window (PLAN.md §5: 2 to 30 s), set by its host or an admin.
export function setDebounce(db: Db, caller: Caller, ms: number): RoomState {
  return db.tx(() => {
    const room = openRoom(db, caller.roomId)
    if (caller.login !== room.hostLogin && !isAdmin(caller.role)) fail(403, 'only the host or an admin sets the batching window')
    const debounce = clampDebounce(ms)
    db.run('UPDATE room_state SET debounce_ms = ?, updated_at = ? WHERE room_id = ?', debounce, now(), room.id)
    appendLog(db, room.id, 'system', caller.login, `the coordinator now waits ${debounce / 1000} s after the last message (set by ${caller.login})`, {
      change: 'batch',
      debounceMs: debounce,
    })
    return roomState(db, room.id)
  })
}
