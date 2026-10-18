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
// The models a room asks for, by slot (PLAN.md phase 4): a slot left out has
// no room default. A member's own choice for their machine wins over it.
export type RoomModels = Partial<Record<ModelSlot, string>>

export type Room = {
  id: string
  name: string
  visibility: RoomVisibility
  // The repo the room works in (D22); null when the host has none.
  repoUrl: string | null
  // The branch its work starts from: task branches and worktrees branch off
  // it. null (or absent, from a room host before) when the host could not tell.
  baseBranch?: string | null
  // The room's model defaults, set by its host or an admin; null (or absent,
  // from a room host before) when none are.
  models?: RoomModels | null
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
  // A request of theirs reached the room host in the last 30 s (PLAN.md phase 3,
  // presence); otherwise they have joined but are not here now.
  isOnline: boolean
  // Their machine could take over hosting (Q7: Node 24, the room host's files,
  // a way to be reached, the room's repo), as their mod reported it; absent
  // until it did (a mod from before phase 3 never does).
  canHost?: boolean
}

export type Task = {
  id: string
  roomId: string
  title: string
  spec: string
  state: TaskState
  difficulty: Difficulty | null
  claimedBy: string | null
  // A login, or COORDINATOR (protocol/coordinator.ts) for a task the
  // coordinator made from the room's messages.
  createdBy: string
  // Whose requests the task carries: its maker's, or the authors of the
  // messages the coordinator made it from or merged into it.
  askedBy: string[]
  createdAt: number
  updatedAt: number
  version: number
  // Planning and review (PLAN.md phase 4, protocol/planning.ts); absent from a
  // room host before. Its run makes a plan of subtasks instead of the work.
  needsPlan?: boolean
  // The task it was planned out of.
  parentId?: string | null
  // What done looks like, as a reviewer can check it (the planner's).
  checks?: string[]
  // The slot its reviews moved it to (null: its difficulty's, slotOf).
  slot?: Difficulty | null
  // Reviewed runs so far, and the failed reviews on its current slot.
  attempts?: number
  failedReviews?: number
  review?: TaskReview | null
}

// A task's latest review: on which slot its run was, who reviewed it (the
// claimer's mod), and what the rule made of it.
export type TaskReview = {
  verdict: 'pass' | 'fail'
  reasons: string[]
  slot: Difficulty
  by: string
  at: number
}

// The coordinator's memory of the room (spec, "Context Management"): small,
// plain, rebuilt by nobody but the coordinator. Every member's mod mirrors it,
// so whoever hosts next carries on from it (PLAN.md §5).
export type Ask = { who: string; what: string; taskId: string | null }
export type RoomState = {
  // Goes up with every commit of the coordinator; a commit names the version it
  // read, and is refused once it moved (compare-and-set).
  version: number
  // The last log seq the coordinator has read: the messages after it are its
  // next batch.
  coordinatorCursor: number
  goals: string[]
  decisions: string[]
  questions: string[]
  asks: Ask[]
  // The batching window's quiet time after the last message (2 to 30 s).
  debounceMs: number
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

// The coordinator's batching window while it is open (protocol/batch.ts):
// how long until it reads, counted from the moment the room host answered, so
// no clock but the receiver's own is involved. null: nothing is waiting.
export type BatchWindow = { closesInMs: number }

export type RoomSnapshot = {
  room: Room
  members: Member[]
  tasks: Task[]
  log: LogEntry[]
  statusText: string
  // Open while messages wait for the coordinator, and only while one reads
  // this room (the host's mod asks for its batches).
  batch: BatchWindow | null
  // null from a room host before the coordinator.
  state: RoomState | null
  // The highest log seq included; pass back as `since` on the next poll.
  cursor: number
  // This room host holds a request with `waitMs` until something happens (a
  // long-poll); one from before phase 3 does not, and is asked every 3 s.
  canWait?: boolean
  // The room's secret (protocol/seal.ts hostProof), for members only: the mod
  // keeps it in $.store, never in $.state. It changes when someone is removed.
  roomSecret?: string
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
  baseBranch?: string
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

// --- handover (PLAN.md §5) ------------------------------------------------------
//
// Planned: the host's mod asks its room host to hand over (POST
// /host/rooms/:id/handover); the room writes a `handover` entry and refuses
// changes from then on (503: members queue them). Unplanned: members notice
// 30 s without an answer. Either way the successor's mod starts its own room
// host seeded from its mirror of the room (POST /host/rooms/import), publishes
// the new address in the directory, and the others move there: they check the
// host proof at the new address (POST /host-proof), then join again with their
// SSH signature; the roster carries their role over.

export type HandoverRequest = { to: string }
export type HostProofRequest = { roomId: string; origin: string; nonce: string }
export type HostProofResponse = { proof: string }
// A member's mod says what its machine can do (Q7).
export type MemberReport = { canHost: boolean }

export type ImportRoomRequest = {
  // The room as it was; hostLogin is replaced by `hostLogin` below.
  room: Room
  // The person whose mod imports it: hosts it from now on.
  hostLogin: string
  // Why the host changed, and who hosted before: for the room's log. `hasLeft`:
  // they handed the room over and left it; otherwise their machine stopped
  // answering, and they stay in the roster to come back as a member.
  from: string
  reason: string
  hasLeft: boolean
  roomSecret: string
  // A private room's key (its hash is kept); null for an open room.
  roomKey: string | null
  members: Omit<Member, 'isOnline' | 'canHost'>[]
  tasks: Task[]
  state: RoomState
  status: { doing: string; decided: string[]; planned: string[]; blocked: string[] }
  // Oldest first, with their seqs: the new room host carries on numbering after them.
  log: LogEntry[]
}
export type ImportRoomResponse = { room: Room; token: string }

// The `data` of the two system entries a handover writes.
export type HandoverData = { change: 'handover'; from: string; to: string }
export type HostChangeData = { change: 'host'; host: string; from: string; importedUpTo: number; reason: string }

// Member routes (Authorization: Bearer <session token>)
export type PostMessageRequest = { body: string }
export type CreateTaskRequest = { title: string; spec?: string; difficulty?: Difficulty; needsPlan?: boolean }
export type ReleaseTaskRequest = { reason?: string }
// The room's model defaults, whole (the host or an admin); {} takes them away.
export type SetRoomModelsRequest = { models: RoomModels }
export type SetTaskStateRequest = { state: TaskState; version: number }
// How a run of a claimed task went (PLAN.md phase 3): the worker's report, and
// the branch it worked on when it ran in a worktree.
export type TaskResultRequest = { summary: string; isFinished: boolean; branch?: string | null }
// A needsPlan task's plan (protocol/planning.ts PlanDraft), from its claimer:
// the subtasks go on the map and the task is done.
export type TaskPlanRequest = {
  summary: string
  subtasks: { title: string; spec: string; difficulty: Difficulty; checks: string[] }[]
}
export type TaskPlanResponse = { task: Task; subtasks: Task[] }
// The review of a run, from its claimer; `slot`: the one the run was on (a
// review of a run on a slot the task has left is refused).
export type TaskReviewRequest = { verdict: 'pass' | 'fail'; reasons: string[]; slot: Difficulty }
export type TaskReviewResponse = { task: Task; outcome: 'passed' | 'retry' | 'escalated' | 'blocked' }
export type ReportFilesRequest = { paths: string[] }
export type UpdateStatusRequest = { doing?: string; decided?: string[]; planned?: string[]; blocked?: string[] }

export type ApiError = { error: string }
