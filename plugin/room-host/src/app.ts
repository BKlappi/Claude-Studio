import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { GITHUB_LOGIN, isOrigin, loginKey, originOf } from '../../protocol/join.ts'
import type { CommitResponse, CoordinatorAction, NextBatchResponse } from '../../protocol/coordinator.ts'
import { isBranchName } from '../../protocol/branch.ts'
import { isModelId } from '../../protocol/models.ts'
import { hostProof } from '../../protocol/seal.ts'
import type {
  AdmitResponse,
  CreateRoomResponse,
  HostProofResponse,
  ImportRoomRequest,
  ImportRoomResponse,
  MeResponse,
  PendingJoin,
  RoomSnapshot,
  TaskPlanResponse,
  TaskReviewResponse,
} from '../../protocol/types.ts'
import { announceHandover, importRoom } from './handover.ts'
import { createLimiter } from './limits.ts'
import { ghAccess } from './access.ts'
import type { CheckAccess } from './access.ts'
import type { Db } from './db/index.ts'
import { githubKeys } from './github.ts'
import { createJoins } from './joins.ts'
import { latestSeq } from './log.ts'
import { batchClosing, commitBatch, createCoordinatorWatch, nextBatch, postNote, roomState, setDebounce, windowOf } from './coordinator.ts'
import {
  admit,
  callerForToken,
  closeRoom,
  createPresence,
  createRoom,
  hostRooms,
  kick,
  leaveRoom,
  openRoom,
  postMessage,
  reportFiles,
  roomSecret,
  setRoomModels,
  snapshot,
  updateStatus,
} from './rooms.ts'
import type { Caller } from './rooms.ts'
import { claimTask, createTask, planTask, postResult, releaseTask, reviewTask, setTaskState } from './tasks.ts'
import { HttpError, sameSecret } from './util.ts'
import { MAX_WAIT_MS, createWaits } from './waits.ts'

export type AppConfig = {
  db: Db
  // Authenticates the /host routes: only the host's own mod holds it.
  hostKey: string
  // After a room closed: its last member left, or the host closed it.
  onRoomClosed?: (roomId: string) => void
  // After POST /host/close answered: the process should exit.
  onClose?: () => void
  // The addresses this process answers at on its own machine (its loopback
  // address with the port); joins signed for them are accepted as well as for
  // the public addresses the host's mod sets (PUT /host/origins).
  localOrigins?: () => readonly string[]
  // For tests: the joiner's repo permission and GitHub key list.
  checkAccess?: CheckAccess
  githubKeys?: (login: string) => Promise<string[] | null>
  now?: () => number
}
type Env = { Variables: { caller: Caller } }

export const MAX_BODY_BYTES = 256 * 1024

const login = z.string().regex(GITHUB_LOGIN, 'not a GitHub login')
const roomId = z.string().regex(/^[0-9a-f-]{36}$/, 'not a room id')
const nonce = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'not a nonce')
const role = z.enum(['owner', 'admin', 'member'])
const difficulty = z.enum(['easy', 'medium', 'hard'])
const line = z.string().max(200)
// A git branch name as a room carries it (protocol/branch.ts isBranchName).
const branchName = z.string().max(200).refine(isBranchName, 'not a branch name')
// The room's model defaults: a model id per slot, as the engine takes one.
const modelId = z.string().refine(isModelId, 'not a model id')
const roomModels = z.object({ hard: modelId.optional(), medium: modelId.optional(), easy: modelId.optional() }).strict()
const schemas = {
  createRoom: z.object({
    name: z.string(),
    visibility: z.enum(['open', 'private']).optional(),
    repoUrl: z.string().max(500).optional(),
    baseBranch: branchName.optional(),
    login,
    role,
  }),
  admit: z.object({ login, role, verified: z.boolean(), keyFingerprint: z.string().max(100).optional() }),
  message: z.object({ body: z.string().max(20_000) }),
  createTask: z.object({ title: line, spec: z.string().max(20_000).optional(), difficulty: difficulty.optional(), needsPlan: z.boolean().optional() }),
  release: z.object({ reason: line.optional() }),
  taskState: z.object({ state: z.enum(['open', 'claimed', 'done', 'blocked']), version: z.number().int() }),
  result: z.object({ summary: z.string().max(4000), isFinished: z.boolean(), branch: branchName.nullable().optional() }),
  // Shapes only: checkPlan and checkReview (protocol/planning.ts) clean and cut.
  plan: z.object({
    summary: z.string().max(4000),
    subtasks: z.array(z.object({
      title: z.string().max(500),
      spec: z.string().max(20_000),
      difficulty,
      checks: z.array(z.string().max(1000)).max(20),
    })).max(20),
  }),
  review: z.object({ verdict: z.enum(['pass', 'fail']), reasons: z.array(z.string().max(1000)).max(20), slot: difficulty }),
  status: z.object({
    doing: line.optional(),
    decided: z.array(line).max(20).optional(),
    planned: z.array(line).max(20).optional(),
    blocked: z.array(line).max(20).optional(),
  }),
  files: z.object({ paths: z.array(z.string().min(1).max(500)).min(1).max(100) }),
  origins: z.object({ origins: z.array(z.string().max(300).refine(isOrigin, 'not an http(s) origin')).max(10) }),
  admitPending: z.object({ role: role.optional() }),
  // The actions themselves are checked by checkActions (protocol/coordinator.ts).
  commit: z.object({
    fromSeq: z.number().int().min(0),
    upToSeq: z.number().int().min(1),
    baseVersion: z.number().int().min(0),
    actions: z.array(z.unknown()).max(50),
    dropped: z.array(z.string().max(300)).max(50).optional(),
    usage: z.object({
      input_tokens: z.number().int().min(0),
      output_tokens: z.number().int().min(0),
      cache_read_input_tokens: z.number().int().min(0),
      cache_creation_input_tokens: z.number().int().min(0),
    }).optional(),
  }),
  note: z.object({ body: z.string().min(1).max(500) }),
  settings: z.object({ batchDebounceMs: z.number().int().min(0).max(120_000) }),
  models: z.object({ models: roomModels }),
  nonce: z.object({ roomId }),
  join: z.object({
    roomId,
    origin: z.string().max(300),
    login,
    nonce,
    signature: z.string().max(8192).nullable(),
    noProof: z.string().max(200).optional(),
    roomKey: z.string().max(200).optional(),
  }),
  handover: z.object({ to: login }),
  proof: z.object({ roomId, origin: z.string().max(300), nonce }),
  report: z.object({ canHost: z.boolean() }),
}

// What a successor's mod carries over (src/handover.ts), as strict as the
// routes that wrote it in the first place.
const loginOrNull = login.nullable()
const strings = z.array(z.string().max(200)).max(20)
const importSchema = z.object({
  room: z.object({
    id: roomId,
    name: z.string().min(1).max(48),
    visibility: z.enum(['open', 'private']),
    repoUrl: z.string().max(500).nullable(),
    baseBranch: branchName.nullable().optional(),
    models: roomModels.nullable().optional(),
    hostLogin: login,
    createdAt: z.number().int(),
  }),
  hostLogin: login,
  from: login,
  reason: z.string().min(1).max(200),
  hasLeft: z.boolean(),
  roomSecret: z.string().min(20).max(200),
  roomKey: z.string().min(20).max(200).nullable(),
  members: z.array(z.object({ login, role, verified: z.boolean(), joinedAt: z.number().int() })).min(1).max(500),
  tasks: z.array(z.object({
    id: z.string().min(1).max(64),
    roomId: z.string().max(64),
    title: z.string().min(1).max(200),
    spec: z.string().max(20_000),
    state: z.enum(['open', 'claimed', 'done', 'blocked']),
    difficulty: difficulty.nullable(),
    claimedBy: loginOrNull,
    createdBy: z.string().min(1).max(40),
    askedBy: z.array(login).max(100),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    version: z.number().int().min(1),
    // Phase 4; absent in the mirror of a room host from before.
    needsPlan: z.boolean().optional(),
    parentId: z.string().min(1).max(64).nullable().optional(),
    checks: z.array(z.string().max(500)).max(20).optional(),
    slot: difficulty.nullable().optional(),
    attempts: z.number().int().min(0).max(1000).optional(),
    failedReviews: z.number().int().min(0).max(1000).optional(),
    review: z.object({
      verdict: z.enum(['pass', 'fail']),
      reasons: z.array(z.string().max(500)).max(20),
      slot: difficulty,
      by: login,
      at: z.number().int(),
    }).nullable().optional(),
  })).max(2000),
  state: z.object({
    version: z.number().int().min(0),
    coordinatorCursor: z.number().int().min(0),
    goals: strings,
    decisions: strings,
    questions: strings,
    asks: z.array(z.object({ who: login, what: z.string().max(200), taskId: z.string().max(64).nullable() })).max(30),
    debounceMs: z.number().int().min(2000).max(30_000),
  }),
  status: z.object({ doing: z.string().max(200), decided: strings, planned: strings, blocked: strings }),
  log: z.array(z.object({
    seq: z.number().int().min(1),
    roomId: z.string().max(64),
    kind: z.enum(['message', 'system', 'task', 'coordinator', 'status']),
    author: loginOrNull,
    body: z.string().max(20_000),
    data: z.unknown(),
    at: z.number().int(),
  })).max(5000),
})
// An import carries a room's whole mirror: more than any other request.
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024

// Who is calling, as far as the tunnel says (Cloudflare sets
// cf-connecting-ip; Tailscale Funnel x-forwarded-for). Only for rate limits:
// every request reaches the room host from 127.0.0.1.
const clientOf = (c: Context) =>
  c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() ?? 'direct'

const bearer = (c: Context) => {
  const header = c.req.header('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
}

const body = async <T>(c: Context, schema: z.ZodType<T>) => schema.parse(await c.req.json().catch(() => ({})))

export function createApp(config: AppConfig) {
  const { db, hostKey, onRoomClosed = () => {}, onClose = () => {}, localOrigins = () => [] } = config
  const app = new Hono<Env>()
  const presence = createPresence(config.now)
  const waits = createWaits(db)
  const coordinators = createCoordinatorWatch()
  let origins: readonly string[] = []
  const isOwnOrigin = (origin: string) => origins.includes(origin) || localOrigins().map(originOf).includes(origin)
  const joins = createJoins({
    db,
    checkAccess: config.checkAccess ?? ghAccess(),
    githubKeys: config.githubKeys ?? (name => githubKeys(name)),
    isOwnOrigin,
    now: config.now,
  })
  // Rooms whose host is handing them over (the process ends soon after): to whom.
  const handingOver = new Map<string, string>()
  const proofs = createLimiter(60_000, config.now)

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status)
    if (error instanceof z.ZodError) {
      const message = error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')
      return c.json({ error: message }, 400)
    }
    console.error(error)
    return c.json({ error: 'internal error' }, 500)
  })

  const limitFor = (maxSize: number) => bodyLimit({ maxSize, onError: c => c.json({ error: `request body over ${maxSize} bytes` }, 413) })
  const importLimit = limitFor(MAX_IMPORT_BYTES)
  const bodyLimitOf = limitFor(MAX_BODY_BYTES)
  app.use('*', (c, next) => (c.req.path === '/host/rooms/import' ? importLimit(c, next) : bodyLimitOf(c, next)))

  app.get('/health', c => c.json({ ok: true }))

  // --- the host's own mod (Bearer <hostKey>) ---------------------------------

  const requireHost: MiddlewareHandler<Env> = async (c, next) => {
    if (!sameSecret(bearer(c), hostKey)) throw new HttpError(401, 'host key required')
    await next()
  }
  app.use('/host/*', requireHost)

  app.get('/host/rooms', c => c.json(hostRooms(db, presence)))

  app.post('/host/rooms', async c => {
    const input = await body(c, schemas.createRoom)
    const created: CreateRoomResponse = createRoom(db, {
      name: input.name,
      visibility: input.visibility ?? 'open',
      repoUrl: input.repoUrl ?? null,
      baseBranch: input.baseBranch ?? null,
      login: input.login,
      role: input.role,
    })
    return c.json(created, 201)
  })

  // A successor carries the room on here (src/handover.ts).
  app.post('/host/rooms/import', async c => {
    const imported: ImportRoomResponse = importRoom(db, (await body(c, importSchema)) as ImportRoomRequest)
    return c.json(imported, 201)
  })

  // The host person leaves and hands the room to `to`: the room says so, and
  // takes no more changes (its process ends soon after).
  app.post('/host/rooms/:id/handover', async c => {
    const id = c.req.param('id')
    const { to } = await body(c, schemas.handover)
    const entry = announceHandover(db, id, to)
    handingOver.set(id, loginKey(to))
    return c.json(entry, 201)
  })

  app.post('/host/rooms/:id/members', async c => {
    const admitted: AdmitResponse = admit(db, c.req.param('id'), await body(c, schemas.admit))
    return c.json(admitted, 201)
  })

  app.delete('/host/rooms/:id/members/:login', c => {
    kick(db, c.req.param('id'), c.req.param('login'))
    presence.forget(c.req.param('id'), loginKey(c.req.param('login')))
    return c.json({ ok: true })
  })

  app.post('/host/rooms/:id/close', c => {
    const roomId = c.req.param('id')
    closeRoom(db, roomId, 'closed by the host')
    onRoomClosed(roomId)
    return c.json({ ok: true })
  })

  app.post('/host/close', c => {
    onClose()
    return c.json({ ok: true })
  })

  app.put('/host/origins', async c => {
    origins = (await body(c, schemas.origins)).origins.map(originOf)
    return c.json({ ok: true })
  })

  // The coordinator (src/coordinator.ts): the host's mod asks for the next
  // batch, which this holds until its batching window closes (or waitMs), then
  // commits its actions.
  app.get('/host/rooms/:id/coordinator', async c => {
    const id = c.req.param('id')
    openRoom(db, id)
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Number(c.req.query('waitMs') ?? 0) || 0))
    coordinators.seen(id)
    const isReady = await waits.until(`coordinator:${id}`, waitMs, () => {
      const closesAt = batchClosing(db, id)
      if (closesAt === null) return false
      const left = closesAt - Date.now()
      return left <= 0 ? true : left
    })
    coordinators.seen(id)
    const batch = isReady ? nextBatch(db, id, presence) : null
    if (batch !== null) coordinators.reading(id)
    const answer: NextBatchResponse = { batch }
    return c.json(answer)
  })

  app.post('/host/rooms/:id/coordinator', async c => {
    const id = c.req.param('id')
    if (handingOver.has(id)) throw new HttpError(503, 'the room is moving to another host: its coordinator reads there')
    const commit = await body(c, schemas.commit)
    const committed: CommitResponse = commitBatch(db, id, { ...commit, actions: commit.actions as CoordinatorAction[] })
    coordinators.done(id)
    return c.json(committed)
  })

  app.post('/host/rooms/:id/coordinator/note', async c => {
    const { body: text } = await body(c, schemas.note)
    return c.json(postNote(db, c.req.param('id'), text), 201)
  })

  app.get('/host/joins', c => {
    const waiting: PendingJoin[] = joins.waiting()
    return c.json(waiting)
  })

  app.post('/host/joins/:id/admit', async c => {
    const { role: as = 'member' } = await body(c, schemas.admitPending)
    joins.decide(c.req.param('id'), { role: as })
    return c.json({ ok: true })
  })

  app.post('/host/joins/:id/refuse', c => {
    joins.decide(c.req.param('id'), 'refuse')
    return c.json({ ok: true })
  })

  // --- joining: no session yet (PLAN.md phase 1, src/joins.ts) ----------------

  // A room on its way to another host takes nobody in.
  const refuseWhileMoving: MiddlewareHandler<Env> = async (c, next) => {
    if (handingOver.size > 0) throw new HttpError(503, 'the room is moving to another host: join it there')
    await next()
  }
  app.use('/join', refuseWhileMoving)
  app.use('/join/*', refuseWhileMoving)

  // A member checks that this room host hosts their room before they trust a
  // new address (protocol/seal.ts hostProof): proved only for its own addresses.
  app.post('/host-proof', async c => {
    if (!proofs.take('all', 600) || !proofs.take(`client:${clientOf(c)}`, 60)) throw new HttpError(429, 'too many proofs asked for: wait a minute')
    const { roomId: id, origin, nonce: challenge } = await body(c, schemas.proof)
    openRoom(db, id)
    const dialled = originOf(origin)
    if (!isOrigin(dialled) || !isOwnOrigin(dialled)) throw new HttpError(400, `this room host is not reachable at ${dialled} as far as it knows`)
    const answer: HostProofResponse = { proof: await hostProof(roomSecret(db, id), { roomId: id, origin: dialled, nonce: challenge }) }
    return c.json(answer)
  })

  app.post('/join/nonce', async c => {
    const { roomId: id } = await body(c, schemas.nonce)
    return c.json(joins.issueNonce(id, clientOf(c)))
  })

  app.post('/join', async c => {
    const { status, body: answer } = await joins.join(await body(c, schemas.join), clientOf(c))
    return c.json(answer, status)
  })

  app.get('/join/tickets/:ticket', c => c.json(joins.readTicket(c.req.param('ticket'))))

  // --- members (Bearer <session token>) ---------------------------------------

  const requireMember: MiddlewareHandler<Env> = async (c, next) => {
    const token = bearer(c)
    const caller = token === '' ? undefined : callerForToken(db, token)
    if (caller === 'closed') throw new HttpError(410, 'the room is closed')
    if (caller === undefined) throw new HttpError(401, 'not in this room: join it again')
    c.set('caller', caller)
    // Any request of theirs says they are here (PLAN.md phase 3, presence).
    presence.seen(caller.roomId, caller.login)
    await next()
  }
  app.use('/v1/*', requireMember)

  // A session token opens its own room only; any other looks absent.
  app.use('/v1/rooms/:id/*', async (c, next) => {
    if (c.req.param('id') !== c.get('caller').roomId) throw new HttpError(404, 'no such room')
    // Handed over: reading goes on until the process ends (members must see
    // the handover entry), changes wait in each member's mod for the new host.
    const to = handingOver.get(c.get('caller').roomId)
    if (to !== undefined && c.req.method !== 'GET' && !c.req.path.endsWith('/leave')) {
      throw new HttpError(503, `the room is moving to ${to}'s machine: this is kept and sent there`)
    }
    await next()
  })

  // What this member's machine can do (Q7): kept in memory, like presence.
  app.put('/v1/rooms/:id/me', async c => {
    const caller = c.get('caller')
    const { canHost } = await body(c, schemas.report)
    presence.report(caller.roomId, caller.login, canHost)
    return c.json({ ok: true })
  })

  app.get('/v1/me', c => {
    const caller = c.get('caller')
    const me: MeResponse = { login: caller.login, role: caller.role, room: openRoom(db, caller.roomId) }
    return c.json(me)
  })

  // `waitMs` makes it a long-poll (PLAN.md phase 3): with nothing after `since`
  // yet, it answers once something is, or after waitMs (25 s at most). A first
  // load (since 0) answers at once. `canWait` tells the mod this host waits.
  app.get('/v1/rooms/:id/snapshot', async c => {
    let caller = c.get('caller')
    const since = Math.max(0, Number(c.req.query('since') ?? 0) || 0)
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Number(c.req.query('waitMs') ?? 0) || 0))
    if (waitMs > 0 && since > 0) {
      await waits.until(`member:${caller.roomId}/${caller.login}`, waitMs, () => latestSeq(db, caller.roomId) > since)
      // Removed, or the room closed, while it waited.
      const still = callerForToken(db, bearer(c))
      if (still === 'closed') throw new HttpError(410, 'the room is closed')
      if (still === undefined) throw new HttpError(401, 'not in this room: join it again')
      caller = still
      presence.seen(caller.roomId, caller.login)
    }
    const coordinator = { state: roomState(db, caller.roomId), batch: coordinators.isActive(caller.roomId) ? windowOf(db, caller.roomId) : null }
    const answer: RoomSnapshot = { ...snapshot(db, caller, since, presence, coordinator), canWait: true, roomSecret: roomSecret(db, caller.roomId) }
    return c.json(answer)
  })

  app.put('/v1/rooms/:id/settings', async c => {
    const { batchDebounceMs } = await body(c, schemas.settings)
    return c.json(setDebounce(db, c.get('caller'), batchDebounceMs))
  })

  // The room's model defaults (PLAN.md phase 4).
  app.put('/v1/rooms/:id/models', async c => {
    const { models } = await body(c, schemas.models)
    return c.json(setRoomModels(db, c.get('caller'), models))
  })

  app.post('/v1/rooms/:id/leave', c => {
    const caller = c.get('caller')
    const { isClosed } = leaveRoom(db, caller)
    presence.forget(caller.roomId, caller.login)
    if (isClosed) onRoomClosed(caller.roomId)
    return c.json({ ok: true })
  })

  app.post('/v1/rooms/:id/messages', async c => {
    const { body: text } = await body(c, schemas.message)
    return c.json(postMessage(db, c.get('caller'), text), 201)
  })

  app.post('/v1/rooms/:id/tasks', async c => {
    const input = await body(c, schemas.createTask)
    return c.json(createTask(db, c.get('caller'), input), 201)
  })

  app.post('/v1/rooms/:id/tasks/:taskId/claim', c => c.json(claimTask(db, c.get('caller'), c.req.param('taskId'))))

  app.post('/v1/rooms/:id/tasks/:taskId/release', async c => {
    const { reason } = await body(c, schemas.release)
    return c.json(releaseTask(db, c.get('caller'), c.req.param('taskId'), reason))
  })

  app.post('/v1/rooms/:id/tasks/:taskId/state', async c => {
    const { state, version } = await body(c, schemas.taskState)
    return c.json(setTaskState(db, c.get('caller'), c.req.param('taskId'), state, version))
  })

  app.post('/v1/rooms/:id/tasks/:taskId/result', async c => {
    const input = await body(c, schemas.result)
    return c.json(postResult(db, c.get('caller'), c.req.param('taskId'), input), 201)
  })

  // Planning and review (PLAN.md phase 4, protocol/planning.ts).
  app.post('/v1/rooms/:id/tasks/:taskId/plan', async c => {
    const planned: TaskPlanResponse = planTask(db, c.get('caller'), c.req.param('taskId'), await body(c, schemas.plan))
    return c.json(planned, 201)
  })

  app.post('/v1/rooms/:id/tasks/:taskId/review', async c => {
    const reviewed: TaskReviewResponse = reviewTask(db, c.get('caller'), c.req.param('taskId'), await body(c, schemas.review))
    return c.json(reviewed)
  })

  app.put('/v1/rooms/:id/status', async c => {
    const patch = await body(c, schemas.status)
    return c.text(updateStatus(db, c.get('caller'), patch))
  })

  app.post('/v1/rooms/:id/files', async c => {
    const { paths } = await body(c, schemas.files)
    reportFiles(db, c.get('caller'), paths)
    return c.json({ ok: true })
  })

  return app
}
