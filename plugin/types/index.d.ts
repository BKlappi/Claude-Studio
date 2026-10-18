// The mod's $.state contract. It must be self-contained (no imports), so
// these mirror ../protocol/types.ts; tests/contract.test.ts fails to
// type-check if the two drift apart.
//
// Any plugin can read $.state, so nothing secret lives here: the session
// token stays in $.store.

export type MemberView = {
  login: string
  role: 'owner' | 'admin' | 'member'
  verified: boolean
  joinedAt: number
  // A request of theirs reached the room host in the last 30 s.
  isOnline: boolean
  // Their machine could take over hosting, as their mod reported it.
  canHost?: boolean
}

export type RoomInfo = {
  id: string
  name: string
  visibility: 'open' | 'private'
  repoUrl: string | null
  baseBranch?: string | null
  // The room's model defaults by slot (the host's or an admin's); a slot left
  // out has none, and a member's own choice wins over them.
  models?: { hard?: string; medium?: string; easy?: string } | null
  hostLogin: string
  createdAt: number
}

export type TaskView = {
  id: string
  roomId: string
  title: string
  spec: string
  state: 'open' | 'claimed' | 'done' | 'blocked'
  difficulty: 'easy' | 'medium' | 'hard' | null
  claimedBy: string | null
  // A login, or '@coordinator' for a task the coordinator made.
  createdBy: string
  // Whose requests the task carries.
  askedBy: string[]
  createdAt: number
  updatedAt: number
  version: number
  // Planning and review (PLAN.md phase 4): its run plans it into subtasks.
  needsPlan?: boolean
  // The task it was planned out of.
  parentId?: string | null
  // What done looks like, as a reviewer can check it.
  checks?: string[]
  // The slot its reviews moved it to (null: its difficulty's).
  slot?: 'easy' | 'medium' | 'hard' | null
  // Reviewed runs so far, and the failed reviews on its current slot.
  attempts?: number
  failedReviews?: number
  review?: TaskReviewView | null
}

// A task's latest review.
export type TaskReviewView = {
  verdict: 'pass' | 'fail'
  reasons: string[]
  slot: 'easy' | 'medium' | 'hard'
  by: string
  at: number
}

// The coordinator's memory of the room, mirrored by every member (handover).
export type RoomStateView = {
  version: number
  coordinatorCursor: number
  goals: string[]
  decisions: string[]
  questions: string[]
  asks: { who: string; what: string; taskId: string | null }[]
  debounceMs: number
}

export type LogEntryView = {
  seq: number
  roomId: string
  kind: 'message' | 'system' | 'task' | 'coordinator' | 'status'
  author: string | null
  body: string
  data: unknown
  at: number
}

// Who this session is in its room, and where that room is hosted.
export type Account = { login: string; role: 'owner' | 'admin' | 'member'; hostUrl: string }

// The coordinator's batching window while it is open: milliseconds until it
// reads, from the moment the room host answered (SyncState.lastOkAt is when
// this side got that answer).
export type BatchView = { closesInMs: number }

export type RoomView = {
  room: RoomInfo
  members: MemberView[]
  tasks: TaskView[]
  log: LogEntryView[]
  statusText: string
  batch: BatchView | null
  state: RoomStateView | null
  cursor: number
}

// What this person said to a task from someone else (PLAN.md D23): run it
// here, run it in its own worktree, or not now. A task with no entry still
// waits for the answer.
export type RunChoice = 'here' | 'worktree' | 'later'

// A claimed task running on this machine (hooks/runs.ts): Studio's worker,
// here or in the task's worktree, or its planner.
export type RunView = {
  // The worker's agent id; null while it starts.
  agentId: string | null
  where: 'here' | 'worktree'
  // Where it works, and the task branch when in a worktree.
  cwd: string
  branch: string | null
  // `reviewing`: the work is done and the reviewer reads it (PLAN.md phase 4).
  phase: 'starting' | 'running' | 'reviewing' | 'finished' | 'stopped'
  startedAt: number
  // Where it runs, the first line of its report, or why it stopped.
  note: string
  // The task's work, or its plan (Studio's planner splits it into subtasks);
  // absent: the work (a run from before phase 4).
  kind?: 'work' | 'plan'
  // The model slot it runs on, and which attempt at the task it is (from 1).
  slot?: 'easy' | 'medium' | 'hard'
  attempt?: number
  // What the review measures the change from: the commit the worktree started
  // at, or a snapshot of the person's checkout as the run found it.
  base?: string | null
}

export type SyncState = {
  lastOkAt: number | null
  error: string | null
  // Polls that failed in a row: 0 while the room host answers. The pane says
  // "reconnecting" from the first.
  failures: number
  // Messages and tasks typed while the room host did not answer, sent in order
  // once it does.
  queued: number
}

// Someone waiting for the host person to let them in (protocol PendingJoin).
export type PendingJoinView = {
  id: string
  roomId: string
  login: string
  verified: boolean
  reason: string
  at: number
}

// This session hosting its room: the room host and the address provider
// (PLAN.md D15, D16). The address is not secret; a private room's key never
// sits here.
export type HostingView = {
  phase: 'starting' | 'exposing' | 'resolving' | 'up' | 'restarting' | 'lost'
  provider: 'tailscale' | 'funnel' | 'cloudflared' | 'lan' | null
  // The public address joiners dial, once there is one.
  address: string | null
  // A standing caveat of the provider (LAN: no TLS; tailnet only).
  warning: string | null
  // What just happened (a restart, an address that changed, why it was lost).
  note: string | null
}

// The room moving to another host (PLAN.md §5), as this session sees it:
// waiting for the new host's address, taking over hosting itself, or joining
// the new room host.
export type HandoverView = {
  phase: 'waiting' | 'hosting' | 'joining' | 'failed'
  // Who hosted, and who takes over when that is known.
  from: string
  to: string | null
  // A planned handover (the host left) or the host's machine stopped answering.
  isPlanned: boolean
  // When this session's turn to take over comes, if it is a candidate.
  turnAt: number | null
  note: string
}

// This session joining a room, while it takes longer than one command.
export type JoiningView = {
  phase: 'resolving' | 'waiting' | 'failed'
  address: string
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    studio: {
      account: Account | null
      roomView: RoomView | null
      sync: SyncState
      hosting: HostingView | null
      joins: PendingJoinView[]
      joining: JoiningView | null
      handover: HandoverView | null
      // Ids of the tasks whose spec the pane shows.
      expanded: string[]
      // The answer to each approval card, by task id.
      approvals: Record<string, RunChoice>
      // Each task's run on this machine, by task id.
      runs: Record<string, RunView>
    }
  }
}
