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
}

export type RoomInfo = {
  id: string
  name: string
  visibility: 'open' | 'private'
  repoUrl: string | null
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
  createdBy: string
  createdAt: number
  updatedAt: number
  version: number
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

export type RoomView = {
  room: RoomInfo
  members: MemberView[]
  tasks: TaskView[]
  log: LogEntryView[]
  statusText: string
  cursor: number
}

export type SyncState = { lastOkAt: number | null; error: string | null }

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
    }
  }
}
