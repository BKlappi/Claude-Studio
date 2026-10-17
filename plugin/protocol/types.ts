// Shared wire types between the room host and the Studio mod.
// Pure TypeScript, no runtime imports: the mod's engine and Node's type
// stripping both load this folder as-is.
//
// People are GitHub logins, lowercased (PLAN.md D6, D19). There is no team
// record: the team is the repo's collaborators.

export type Role = 'owner' | 'admin' | 'member'
export type RoomVisibility = 'open' | 'private'
export type TaskState = 'open' | 'claimed' | 'done' | 'blocked'
export type Difficulty = 'easy' | 'medium' | 'hard'
export type ModelSlot = Difficulty

export type Room = {
  id: string
  name: string
  visibility: RoomVisibility
  // The repo the room works in (D22); null when the host has none.
  repoUrl: string | null
  // Whose machine runs the room host.
  hostLogin: string
  createdAt: number
}

export type Member = {
  login: string
  role: Role
  // true: proved the login with an SSH signature; false: admitted by hand.
  verified: boolean
  joinedAt: number
}

export type Task = {
  id: string
  roomId: string
  title: string
  spec: string
  state: TaskState
  difficulty: Difficulty | null
  claimedBy: string | null
  createdBy: string
  createdAt: number
  updatedAt: number
  version: number
}

// The room log is append-only and the room's source of truth while it is
// open. Tasks and the status are projections written in the same transaction,
// so a coordinator can be rebuilt from the log alone.
export type LogKind =
  | 'message'      // a member's text, author-tagged
  | 'system'       // join, leave, close, host handover, limit handoff
  | 'task'         // task created, claimed, state changed
  | 'coordinator'  // the room agent's merges, splits, rejections
  | 'status'       // the room status changed

export type LogEntry = {
  seq: number
  roomId: string
  kind: LogKind
  // The login that wrote it; null for the room host's own entries.
  author: string | null
  body: string
  data: unknown
  at: number
}

export type RoomSnapshot = {
  room: Room
  members: Member[]
  tasks: Task[]
  log: LogEntry[]
  statusText: string
  // The highest log seq included; pass back as `since` on the next poll.
  cursor: number
}

export type MeResponse = { login: string; role: Role; room: Room }

// --- the room host process ------------------------------------------------
// `node room-host/src/index.ts --port 0` writes one JSON line per event on
// standard output. The host key authenticates the /host routes.

export type HostEvent =
  | { event: 'ready'; port: number; hostKey: string }
  // `node room-host/src/relay.ts`, the LAN address provider, says where it listens.
  | { event: 'relay'; address: string }
  | { event: 'room-closed'; roomId: string }
  | { event: 'exiting' }

// --- requests -------------------------------------------------------------

// Host routes (Authorization: Bearer <hostKey>)
export type CreateRoomRequest = {
  name: string
  visibility?: RoomVisibility
  repoUrl?: string
  // The host person, who joins the room as its first member.
  login: string
  role: Role
}
// roomKey: a private room's key, handed out once (invite links carry it);
// null for an open room.
export type CreateRoomResponse = { room: Room; token: string; roomKey: string | null }
export type AdmitRequest = { login: string; role: Role; verified: boolean; keyFingerprint?: string }
export type AdmitResponse = { room: Room; token: string }
export type HostRoom = Room & { members: Member[] }
// The public addresses the room host is reachable at (the address provider's);
// a join signed for any other origin is refused. Its own loopback address is
// always accepted.
export type SetOriginsRequest = { origins: string[] }
// Someone who asked to join and waits for the host person: their SSH proof
// failed or was missing (verified false), or their repo permission could not
// be checked (verified true). `reason` says which.
export type PendingJoin = {
  id: string
  roomId: string
  login: string
  verified: boolean
  reason: string
  at: number
}
export type AdmitPendingRequest = { role?: Role }

// --- joining (no session yet; PLAN.md phase 1, D6) ---------------------------
//
//   POST /join/nonce { roomId }      → JoinNonceResponse
//   sign joinMessage({ roomId, origin, login, nonce }) with ssh-keygen -Y sign
//   POST /join JoinRequest           → 201 admitted · 202 pending · 403 refused
//   GET  /join/tickets/<ticket>      → JoinTicketResponse, while pending

export type JoinNonceRequest = { roomId: string }
export type JoinNonceResponse = { nonce: string; expiresAt: number }
export type JoinRequest = {
  roomId: string
  // The address the joiner dialled, as signed.
  origin: string
  login: string
  nonce: string
  // ssh-keygen's armored signature of joinMessage(...); null when the joiner
  // has no key to prove the login with (`noProof` says why): the host person
  // then decides.
  signature: string | null
  noProof?: string
  // Private rooms: the key from the invite link.
  roomKey?: string
}
export type JoinAdmitted = { status: 'admitted'; room: Room; login: string; role: Role; verified: boolean; token: string }
export type JoinPending = { status: 'pending'; ticket: string; reason: string }
export type JoinResponse = JoinAdmitted | JoinPending
export type JoinTicketResponse = JoinAdmitted | { status: 'pending'; reason: string } | { status: 'refused'; reason: string }

// Member routes (Authorization: Bearer <session token>)
export type PostMessageRequest = { body: string }
export type CreateTaskRequest = { title: string; spec?: string; difficulty?: Difficulty }
export type ReleaseTaskRequest = { reason?: string }
export type SetTaskStateRequest = { state: TaskState; version: number }
export type ReportFilesRequest = { paths: string[] }
export type UpdateStatusRequest = { doing?: string; decided?: string[]; planned?: string[]; blocked?: string[] }

export type ApiError = { error: string }
