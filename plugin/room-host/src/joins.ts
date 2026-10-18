// The join handshake (PLAN.md phase 1, D6, D19): how someone with only an
// invite link gets a session token.
//
//   1. POST /join/nonce   the host hands out a one-time nonce for the room
//   2. the joiner signs joinMessage(room, the origin they dialled, login, nonce)
//      with an SSH key that github.com/<login>.keys lists
//   3. POST /join         the host checks nonce, origin, room key (private
//      rooms), the signature against GitHub's key list, and the login's
//      permission in the room's repo, then admits: write access or more, in;
//      less, refused. When proof or permission cannot be had, the request
//      waits for the host person (GET /host/joins), who admits or refuses;
//      the joiner polls GET /join/tickets/<ticket> meanwhile.
//
// Nonces and waiting requests live in memory: a room host restart forgets
// them, and the joiner simply joins again.

import { GITHUB_LOGIN, JOIN_NAMESPACE, githubRepo, isOrigin, joinMessage, loginKey, originOf } from '../../protocol/join.ts'
import type {
  JoinAdmitted,
  JoinNonceResponse,
  JoinPending,
  JoinRequest,
  JoinTicketResponse,
  PendingJoin,
  Role,
  Room,
} from '../../protocol/types.ts'
import type { CheckAccess } from './access.ts'
import type { Db } from './db/index.ts'
import { createLimiter } from './limits.ts'
import { admit, isVerifiedMember, openRoom, roleIn, roomKeyMatches } from './rooms.ts'
import { verifySshSignature } from './sshsig.ts'
import { fail, newId, randomToken, sha256 } from './util.ts'

export type JoinConfig = {
  db: Db
  checkAccess: CheckAccess
  // github.com/<login>.keys (and signing keys); null when there is no such account.
  githubKeys: (login: string) => Promise<string[] | null>
  // Whether this room host is reachable at `origin` (normalized by originOf).
  isOwnOrigin: (origin: string) => boolean
  now?: () => number
}

export const NONCE_TTL_MS = 2 * 60_000
export const PENDING_TTL_MS = 10 * 60_000
const MAX_NONCES = 500
const MAX_WAITING_PER_ROOM = 10

// Per minute. `client` is the caller's address as the tunnel reports it
// (best effort: every request reaches the room host from 127.0.0.1).
export const JOIN_LIMITS = {
  nonces: 120,
  noncesPerClient: 30,
  joins: 60,
  joinsPerClient: 10,
  joinsPerLogin: 5,
  ticketReads: 600,
}

type Request = PendingJoin & {
  ticketHash: string
  keyFingerprint: string | null
  // Set once the host person decided; handed to the joiner once.
  outcome: JoinTicketResponse | null
  expiresAt: number
}

export type JoinResult = { status: 201; body: JoinAdmitted } | { status: 202; body: JoinPending }

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createJoins(config: JoinConfig) {
  const now = config.now ?? Date.now
  const limiter = createLimiter(60_000, now)
  const nonces = new Map<string, { roomId: string; expiresAt: number }>()
  const requests = new Map<string, Request>()
  const idByTicket = new Map<string, string>()

  function limit(key: string, max: number): void {
    if (!limiter.take(key, max)) fail(429, 'too many join attempts: wait a minute, then join again')
  }

  function forget(request: Request): void {
    requests.delete(request.id)
    idByTicket.delete(request.ticketHash)
  }

  function sweep(): void {
    const at = now()
    for (const [nonce, entry] of nonces) if (entry.expiresAt <= at) nonces.delete(nonce)
    for (const request of requests.values()) if (request.expiresAt <= at) forget(request)
  }

  function issueNonce(roomId: string, client: string): JoinNonceResponse {
    limit('nonces', JOIN_LIMITS.nonces)
    limit(`nonces:${client}`, JOIN_LIMITS.noncesPerClient)
    openRoom(config.db, roomId)
    sweep()
    if (nonces.size >= MAX_NONCES) fail(429, 'too many joins under way: wait a minute, then join again')
    const nonce = randomToken()
    const expiresAt = now() + NONCE_TTL_MS
    nonces.set(nonce, { roomId, expiresAt })
    return { nonce, expiresAt }
  }

  function admitted(roomId: string, login: string, role: Role, verified: boolean, keyFingerprint: string | null): JoinAdmitted {
    const { room, token } = admit(config.db, roomId, { login, role, verified, keyFingerprint: keyFingerprint ?? undefined })
    return { status: 'admitted', room, login, role, verified, token }
  }

  // The host person decides: the request waits in GET /host/joins.
  function wait(room: Room, login: string, verified: boolean, keyFingerprint: string | null, reason: string): JoinResult {
    // Not even asked: admit() would refuse it (src/rooms.ts).
    if (!verified && isVerifiedMember(config.db, room.id, login)) {
      fail(409, `${login} is in the room, verified by SSH key: only that key gets them in again`)
    }
    sweep()
    // One waiting request per login and room: a newer one replaces it.
    for (const request of requests.values()) {
      if (request.roomId === room.id && request.login === login && request.outcome === null) forget(request)
    }
    const waiting = [...requests.values()].filter(request => request.roomId === room.id && request.outcome === null)
    if (waiting.length >= MAX_WAITING_PER_ROOM) fail(429, 'too many people are waiting to be let in: try again later')

    const ticket = randomToken()
    const at = now()
    const request: Request = {
      id: newId(),
      roomId: room.id,
      login,
      verified,
      reason,
      at,
      ticketHash: sha256(ticket),
      keyFingerprint,
      outcome: null,
      expiresAt: at + PENDING_TTL_MS,
    }
    requests.set(request.id, request)
    idByTicket.set(request.ticketHash, request.id)
    return { status: 202, body: { status: 'pending', ticket, reason } }
  }

  async function join(input: JoinRequest, client: string): Promise<JoinResult> {
    limit('joins', JOIN_LIMITS.joins)
    limit(`joins:${client}`, JOIN_LIMITS.joinsPerClient)
    if (!GITHUB_LOGIN.test(input.login)) fail(400, 'not a GitHub login')
    limit(`joins:login:${loginKey(input.login)}`, JOIN_LIMITS.joinsPerLogin)

    // A nonce is good for one try, whatever its outcome.
    const challenge = nonces.get(input.nonce)
    nonces.delete(input.nonce)
    if (challenge === undefined || challenge.expiresAt <= now() || challenge.roomId !== input.roomId) {
      fail(401, 'the join challenge is unknown or expired: join again')
    }
    const origin = originOf(input.origin)
    if (!isOrigin(origin) || !config.isOwnOrigin(origin)) {
      fail(400, `this room host is not reachable at ${origin} as far as it knows: join with a fresh invite link`)
    }
    const room = openRoom(config.db, input.roomId)
    if (room.visibility === 'private' && !roomKeyMatches(config.db, room.id, input.roomKey ?? '')) {
      fail(403, 'the room is private: join with the invite link that carries its key')
    }
    const login = loginKey(input.login)
    if (login === room.hostLogin) fail(409, `${login} hosts this room and is in it already`)

    // The joiner's own word for why there is no proof: shown to the host
    // person as theirs, on one line.
    const theySay = (input.noProof ?? '').replace(/[\u0000-\u001f\u007f"]+/g, ' ').trim().slice(0, 120)
    if (input.signature === null) return wait(room, login, false, null, `no SSH proof (they say: "${theySay || 'nothing'}")`)

    let keys: string[] | null
    try {
      keys = await config.githubKeys(input.login)
    } catch (error) {
      return wait(room, login, false, null, `GitHub's key list could not be read (${describe(error)})`)
    }
    if (keys === null) return fail(403, `GitHub has no account ${input.login}`)
    const proof = verifySshSignature({
      armored: input.signature,
      message: joinMessage({ roomId: room.id, origin, login: input.login, nonce: input.nonce }),
      namespace: JOIN_NAMESPACE,
      allowedKeys: keys,
    })
    if (!proof.ok) return wait(room, login, false, null, `SSH proof failed (${proof.reason})`)

    // Someone the room has already let in comes back in the role they have: a
    // member who lost their session, or one following the room to a new host,
    // which carried the roster over (src/handover.ts). Their access was checked
    // when they were first let in.
    const known = roleIn(config.db, room.id, login)
    if (known !== null) return { status: 201, body: admitted(room.id, login, known, true, proof.fingerprint) }

    const repo = githubRepo(room.repoUrl)
    if (repo === null) return wait(room, login, true, proof.fingerprint, 'the room has no GitHub repo to check access in')
    const access = await config.checkAccess(repo, login)
    if (access.kind === 'refused') {
      return fail(403, `${login} has ${access.permission} access to ${repo.owner}/${repo.name}; rooms need write access`)
    }
    if (access.kind === 'unknown') return wait(room, login, true, proof.fingerprint, access.reason)
    return { status: 201, body: admitted(room.id, login, access.role, true, proof.fingerprint) }
  }

  // The joiner's poll while the host person decides. A decision is handed
  // over once, then the request is gone.
  function readTicket(ticket: string): JoinTicketResponse {
    limit('tickets', JOIN_LIMITS.ticketReads)
    sweep()
    const id = idByTicket.get(sha256(ticket))
    const request = id === undefined ? undefined : requests.get(id)
    if (request === undefined) return fail(404, 'no such join request: it expired or a newer one replaced it, so join again')
    if (request.outcome === null) return { status: 'pending', reason: request.reason }
    forget(request)
    return request.outcome
  }

  function waiting(): PendingJoin[] {
    sweep()
    return [...requests.values()]
      .filter(request => request.outcome === null)
      .map(({ id, roomId, login, verified, reason, at }) => ({ id, roomId, login, verified, reason, at }))
  }

  function decide(id: string, decision: { role: Role } | 'refuse'): void {
    sweep()
    const request = requests.get(id)
    if (request === undefined || request.outcome !== null) return fail(404, 'no such join request')
    request.outcome = decision === 'refuse'
      ? { status: 'refused', reason: 'the host did not let you in' }
      : admitted(request.roomId, request.login, decision.role, request.verified, request.keyFingerprint)
    // Time for the joiner to collect it.
    request.expiresAt = now() + PENDING_TTL_MS
  }

  return { issueNonce, join, readTicket, waiting, decide }
}
