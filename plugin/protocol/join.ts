// Joining a room: the text a joiner signs with an SSH key their GitHub
// account lists (PLAN.md D6), with
//
//   ssh-keygen -Y sign -n studio-join -f <key>      (message on standard input)
//
// It names the room and the address the joiner dialled, so a signature made
// for one host cannot be replayed at another, and a nonce the host chose, so
// it cannot be replayed at the same one.

import type { Role } from './types.ts'

export const JOIN_NAMESPACE = 'studio-join'

// GitHub's own rule: letters, digits and single inner hyphens, up to 39.
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

// GitHub logins are case-insensitive; Studio stores and compares them lowercased.
export const loginKey = (login: string) => login.toLowerCase()

export type JoinChallenge = {
  roomId: string
  // The host's address as the joiner dialled it, e.g. https://x.trycloudflare.com
  origin: string
  login: string
  nonce: string
}

export function originOf(address: string): string {
  return address.trim().replace(/\/+$/, '').toLowerCase()
}

// An address a room host can be dialled at: http(s), a host, maybe a port,
// nothing after it.
export const isOrigin = (address: string) => /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(originOf(address))

export function joinMessage(challenge: JoinChallenge): string {
  const { roomId, login, nonce } = challenge
  const origin = originOf(challenge.origin)
  for (const value of [roomId, origin, login, nonce]) {
    if (value === '' || /\s/.test(value)) throw new Error('join fields must be non-empty, without whitespace')
  }
  if (!GITHUB_LOGIN.test(login)) throw new Error(`not a GitHub login: ${login}`)
  return `studio-join v1\nroom=${roomId}\norigin=${origin}\nlogin=${login}\nnonce=${nonce}\n`
}

// --- invite links -----------------------------------------------------------
//
//   studio:join?room=<room id>&at=<host address>[&key=<room key>]
//
// The key is there for private rooms only: it is a secret, so a link that
// carries one is shared like a password.

export type Invite = { roomId: string; address: string; roomKey: string | null }

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROOM_KEY = /^[A-Za-z0-9_-]{43,128}$/

export const isRoomId = (id: string) => ROOM_ID.test(id)

export function inviteLink(invite: Invite): string {
  const params = new URLSearchParams({ room: invite.roomId, at: originOf(invite.address) })
  if (invite.roomKey !== null) params.set('key', invite.roomKey)
  return `studio:join?${params.toString()}`
}

// The invite in `text` (a link pasted with or without words around it), or
// null when there is none or it is malformed.
export function parseInvite(text: string): Invite | null {
  const query = /studio:join\?(\S+)/.exec(text)?.[1]
  if (query === undefined) return null
  const params = new URLSearchParams(query)
  const roomId = params.get('room') ?? ''
  const address = originOf(params.get('at') ?? '')
  const roomKey = params.get('key')
  if (!ROOM_ID.test(roomId) || !isOrigin(address)) return null
  if (roomKey !== null && !ROOM_KEY.test(roomKey)) return null
  return { roomId: roomId.toLowerCase(), address, roomKey }
}

// --- the room's repo and roles (D19, D22) ----------------------------------

export type GithubRepo = { owner: string; name: string }

const REPO_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/
const GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i

// The GitHub repo a remote URL names (https, scp-like or ssh form), or null
// for anything else (another host, a local path, no URL).
export function githubRepo(url: string | null): GithubRepo | null {
  const match = url === null ? null : GITHUB_REMOTE.exec(url.trim())
  if (!match) return null
  const [, owner = '', name = ''] = match
  return GITHUB_LOGIN.test(owner) && REPO_NAME.test(name) ? { owner, name } : null
}

export const repoUrlOf = (repo: GithubRepo) => `https://github.com/${repo.owner}/${repo.name}`

// A person's access to a repo, as GitHub names it (`role_name`).
export type RepoPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'

// `GET repos/{o}/{r}` answers the signed-in user's access as flags.
export function permissionOf(flags: Partial<Record<'admin' | 'maintain' | 'push' | 'triage' | 'pull', boolean>>): RepoPermission {
  if (flags.admin) return 'admin'
  if (flags.maintain) return 'maintain'
  if (flags.push) return 'write'
  if (flags.triage) return 'triage'
  if (flags.pull) return 'read'
  return 'none'
}

// D19: repo or org owner → owner, admin → admin, maintain/write → member,
// anything that cannot push → no access (null).
export function roleFor(access: { isOwner: boolean; permission: RepoPermission }): Role | null {
  if (access.isOwner) return 'owner'
  if (access.permission === 'admin') return 'admin'
  if (access.permission === 'maintain' || access.permission === 'write') return 'member'
  return null
}
