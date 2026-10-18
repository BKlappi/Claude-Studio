import type { EngineInterface } from 'claude-code'
import type { CommitResponse, CoordinatorCommit, NextBatchResponse } from '../protocol/coordinator'
import type {
  AdmitRequest,
  AdmitResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  CreateTaskRequest,
  HandoverRequest,
  HostProofRequest,
  HostProofResponse,
  HostRoom,
  ImportRoomRequest,
  ImportRoomResponse,
  JoinNonceResponse,
  JoinRequest,
  JoinResponse,
  JoinTicketResponse,
  LogEntry,
  MemberReport,
  MeResponse,
  PendingJoin,
  Role,
  Room,
  RoomModels,
  RoomSnapshot,
  RoomState,
  SetRoomModelsRequest,
  Task,
  TaskPlanRequest,
  TaskPlanResponse,
  TaskResultRequest,
  TaskReviewRequest,
  TaskReviewResponse,
  TaskState,
} from '../protocol/types'

export class StudioError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// The statuses after which this session is no longer in its room: left or
// removed (401), the room is not there (404), the room closed (410).
export const isOutOfRoom = (error: unknown) =>
  error instanceof StudioError && (error.status === 401 || error.status === 404 || error.status === 410)

// The room host does not answer (now): unreachable, or a tunnel or proxy with
// nothing behind it (502, 503, 530). The room is still there; try again.
export const isOffline = (error: unknown) =>
  error instanceof StudioError && (error.status === 0 || error.status >= 500)

// The address does not resolve (yet): a new quick tunnel's name takes a
// while, and a resolver that asked too early remembers "no such name" for
// up to a minute (PLAN.md §9, spike 2).
export const isNameNotFound = (error: unknown) =>
  error instanceof StudioError && error.status === 0 && /ENOTFOUND|EAI_AGAIN/.test(error.message)

// One request to a room host, over $.http.fetch (the host's network, never
// the module's own). `token`: a session token or the host key.
export async function request<T>(
  $: EngineInterface,
  base: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<T> {
  const root = base.replace(/\/+$/, '')
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'

  let response
  try {
    response = await $.http.fetch(`${root}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch (error) {
    throw new StudioError(0, `cannot reach the room host at ${root}: ${error instanceof Error ? error.message : String(error)}`)
  }

  let data: unknown = null
  try {
    data = response.text === '' ? null : JSON.parse(response.text)
  } catch {
    data = response.text
  }
  if (!response.ok) {
    const message = typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : `HTTP ${response.status}`
    throw new StudioError(response.status, message)
  }
  return data as T
}

export type RoomSession = { hostUrl: string; roomId: string; token: string }

// One room on its room host, with this member's session token.
export function client($: EngineInterface, session: RoomSession) {
  const room = `/v1/rooms/${encodeURIComponent(session.roomId)}`
  const task = (taskId: string) => `${room}/tasks/${encodeURIComponent(taskId)}`
  const call = <T>(method: string, path: string, body?: unknown) =>
    request<T>($, session.hostUrl, method, path, { token: session.token, body })

  return {
    me: () => call<MeResponse>('GET', '/v1/me'),
    // With waitMs, a long-poll: the room host answers once there is something
    // after `since`, or after waitMs (PLAN.md phase 3).
    snapshot: (since: number, waitMs = 0) =>
      call<RoomSnapshot>('GET', `${room}/snapshot?since=${since}${waitMs > 0 ? `&waitMs=${waitMs}` : ''}`),
    leave: () => call<{ ok: true }>('POST', `${room}/leave`, {}),
    say: (body: string) => call<LogEntry>('POST', `${room}/messages`, { body }),
    createTask: (input: CreateTaskRequest) => call<Task>('POST', `${room}/tasks`, input),
    claimTask: (taskId: string) => call<Task>('POST', `${task(taskId)}/claim`, {}),
    releaseTask: (taskId: string, reason?: string) => call<Task>('POST', `${task(taskId)}/release`, { reason }),
    // How a run of the task went (hooks/runs.ts).
    taskResult: (taskId: string, result: TaskResultRequest) => call<LogEntry>('POST', `${task(taskId)}/result`, result),
    // A needsPlan task's plan, and a run's review (PLAN.md phase 4).
    planTask: (taskId: string, plan: TaskPlanRequest) => call<TaskPlanResponse>('POST', `${task(taskId)}/plan`, plan),
    reviewTask: (taskId: string, review: TaskReviewRequest) => call<TaskReviewResponse>('POST', `${task(taskId)}/review`, review),
    // `version`: the one the caller saw; a task that changed since is a 409.
    setTaskState: (taskId: string, state: TaskState, version: number) =>
      call<Task>('POST', `${task(taskId)}/state`, { state, version }),
    reportFiles: (paths: string[]) => call<{ ok: true }>('POST', `${room}/files`, { paths }),
    // The coordinator's batching window (the host or an admin).
    setBatchWindow: (debounceMs: number) => call<RoomState>('PUT', `${room}/settings`, { batchDebounceMs: debounceMs }),
    // The room's model defaults, whole (the host or an admin).
    setModels: (models: RoomModels) => call<Room>('PUT', `${room}/models`, { models } satisfies SetRoomModelsRequest),
    // Whether this machine could take over hosting (Q7).
    report: (report: MemberReport) => call<{ ok: true }>('PUT', `${room}/me`, report),
  }
}

// Asks the room host at `address` to prove it hosts the room (protocol/seal.ts):
// no session needed, nothing secret sent.
export function askHostProof($: EngineInterface, address: string, challenge: HostProofRequest) {
  return request<HostProofResponse>($, address, 'POST', '/host-proof', { body: challenge })
}

// The joiner's side of the handshake: no session yet.
export function joinClient($: EngineInterface, address: string) {
  return {
    nonce: (roomId: string) => request<JoinNonceResponse>($, address, 'POST', '/join/nonce', { body: { roomId } }),
    join: (input: JoinRequest) => request<JoinResponse>($, address, 'POST', '/join', { body: input }),
    ticket: (ticket: string) => request<JoinTicketResponse>($, address, 'GET', `/join/tickets/${encodeURIComponent(ticket)}`),
  }
}

// The host's own mod, on its own room host (Bearer <hostKey>).
export function hostClient($: EngineInterface, localUrl: string, hostKey: string) {
  const call = <T>(method: string, path: string, body?: unknown) => request<T>($, localUrl, method, path, { token: hostKey, body })
  return {
    health: () => request<{ ok: true }>($, localUrl, 'GET', '/health'),
    createRoom: (input: CreateRoomRequest) => call<CreateRoomResponse>('POST', '/host/rooms', input),
    rooms: () => call<HostRoom[]>('GET', '/host/rooms'),
    // Handover (PLAN.md §5): the old host's room says so; the successor's
    // carries the room on from its mirror.
    handover: (roomId: string, to: string) => call<LogEntry>('POST', `/host/rooms/${encodeURIComponent(roomId)}/handover`, { to } satisfies HandoverRequest),
    importRoom: (input: ImportRoomRequest) => call<ImportRoomResponse>('POST', '/host/rooms/import', input),
    closeRoom: (roomId: string) => call<{ ok: true }>('POST', `/host/rooms/${encodeURIComponent(roomId)}/close`, {}),
    // A new session token for a member (replacing theirs), without the join handshake.
    admitMember: (roomId: string, input: AdmitRequest) =>
      call<AdmitResponse>('POST', `/host/rooms/${encodeURIComponent(roomId)}/members`, input),
    setOrigins: (origins: string[]) => call<{ ok: true }>('PUT', '/host/origins', { origins }),
    // The coordinator (protocol/coordinator.ts): a long-poll for the next batch,
    // its commit, a note.
    nextBatch: (roomId: string, waitMs: number) =>
      call<NextBatchResponse>('GET', `/host/rooms/${encodeURIComponent(roomId)}/coordinator?waitMs=${waitMs}`),
    commit: (roomId: string, commit: CoordinatorCommit) =>
      call<CommitResponse>('POST', `/host/rooms/${encodeURIComponent(roomId)}/coordinator`, commit),
    note: (roomId: string, body: string) => call<LogEntry>('POST', `/host/rooms/${encodeURIComponent(roomId)}/coordinator/note`, { body }),
    joins: () => call<PendingJoin[]>('GET', '/host/joins'),
    admit: (id: string, role: Role = 'member') => call<{ ok: true }>('POST', `/host/joins/${encodeURIComponent(id)}/admit`, { role }),
    refuse: (id: string) => call<{ ok: true }>('POST', `/host/joins/${encodeURIComponent(id)}/refuse`, {}),
    close: () => call<{ ok: true }>('POST', '/host/close', {}),
  }
}
