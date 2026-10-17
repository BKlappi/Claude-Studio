import type { EngineInterface } from 'claude-code'
import type {
  AdmitRequest,
  AdmitResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  CreateTaskRequest,
  HostRoom,
  JoinNonceResponse,
  JoinRequest,
  JoinResponse,
  JoinTicketResponse,
  LogEntry,
  MeResponse,
  PendingJoin,
  Role,
  RoomSnapshot,
  Task,
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
    snapshot: (since: number) => call<RoomSnapshot>('GET', `${room}/snapshot?since=${since}`),
    leave: () => call<{ ok: true }>('POST', `${room}/leave`, {}),
    say: (body: string) => call<LogEntry>('POST', `${room}/messages`, { body }),
    createTask: (input: CreateTaskRequest) => call<Task>('POST', `${room}/tasks`, input),
    claimTask: (taskId: string) => call<Task>('POST', `${task(taskId)}/claim`, {}),
    releaseTask: (taskId: string, reason?: string) => call<Task>('POST', `${task(taskId)}/release`, { reason }),
    reportFiles: (paths: string[]) => call<{ ok: true }>('POST', `${room}/files`, { paths }),
  }
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
    // A new session token for a member (replacing theirs), without the join handshake.
    admitMember: (roomId: string, input: AdmitRequest) =>
      call<AdmitResponse>('POST', `/host/rooms/${encodeURIComponent(roomId)}/members`, input),
    setOrigins: (origins: string[]) => call<{ ok: true }>('PUT', '/host/origins', { origins }),
    joins: () => call<PendingJoin[]>('GET', '/host/joins'),
    admit: (id: string, role: Role = 'member') => call<{ ok: true }>('POST', `/host/joins/${encodeURIComponent(id)}/admit`, { role }),
    refuse: (id: string) => call<{ ok: true }>('POST', `/host/joins/${encodeURIComponent(id)}/refuse`, {}),
    close: () => call<{ ok: true }>('POST', '/host/close', {}),
  }
}
