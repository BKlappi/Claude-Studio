import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { GITHUB_LOGIN, isOrigin, originOf } from '../../plugin/protocol/join.ts'
import type { AdmitResponse, CreateRoomResponse, MeResponse, PendingJoin } from '../../plugin/protocol/types.ts'
import { ghAccess } from './access.ts'
import type { CheckAccess } from './access.ts'
import type { Db } from './db/index.ts'
import { githubKeys } from './github.ts'
import { createJoins } from './joins.ts'
import {
  admit,
  callerForToken,
  closeRoom,
  createRoom,
  hostRooms,
  kick,
  leaveRoom,
  openRoom,
  postMessage,
  reportFiles,
  snapshot,
  updateStatus,
} from './rooms.ts'
import type { Caller } from './rooms.ts'
import { claimTask, createTask, releaseTask, setTaskState } from './tasks.ts'
import { HttpError, sameSecret } from './util.ts'

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
const schemas = {
  createRoom: z.object({
    name: z.string(),
    visibility: z.enum(['open', 'private']).optional(),
    repoUrl: z.string().max(500).optional(),
    login,
    role,
  }),
  admit: z.object({ login, role, verified: z.boolean(), keyFingerprint: z.string().max(100).optional() }),
  message: z.object({ body: z.string().max(20_000) }),
  createTask: z.object({ title: line, spec: z.string().max(20_000).optional(), difficulty: difficulty.optional() }),
  release: z.object({ reason: line.optional() }),
  taskState: z.object({ state: z.enum(['open', 'claimed', 'done', 'blocked']), version: z.number().int() }),
  status: z.object({
    doing: line.optional(),
    decided: z.array(line).max(20).optional(),
    planned: z.array(line).max(20).optional(),
    blocked: z.array(line).max(20).optional(),
  }),
  files: z.object({ paths: z.array(z.string().min(1).max(500)).min(1).max(100) }),
  origins: z.object({ origins: z.array(z.string().max(300).refine(isOrigin, 'not an http(s) origin')).max(10) }),
  admitPending: z.object({ role: role.optional() }),
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
}

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
  let origins: readonly string[] = []
  const joins = createJoins({
    db,
    checkAccess: config.checkAccess ?? ghAccess(),
    githubKeys: config.githubKeys ?? (name => githubKeys(name)),
    isOwnOrigin: origin => origins.includes(origin) || localOrigins().map(originOf).includes(origin),
    now: config.now,
  })

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status)
    if (error instanceof z.ZodError) {
      const message = error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')
      return c.json({ error: message }, 400)
    }
    console.error(error)
    return c.json({ error: 'internal error' }, 500)
  })

  app.use('*', bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: c => c.json({ error: `request body over ${MAX_BODY_BYTES} bytes` }, 413),
  }))

  app.get('/health', c => c.json({ ok: true }))

  // --- the host's own mod (Bearer <hostKey>) ---------------------------------

  const requireHost: MiddlewareHandler<Env> = async (c, next) => {
    if (!sameSecret(bearer(c), hostKey)) throw new HttpError(401, 'host key required')
    await next()
  }
  app.use('/host/*', requireHost)

  app.get('/host/rooms', c => c.json(hostRooms(db)))

  app.post('/host/rooms', async c => {
    const input = await body(c, schemas.createRoom)
    const created: CreateRoomResponse = createRoom(db, {
      name: input.name,
      visibility: input.visibility ?? 'open',
      repoUrl: input.repoUrl ?? null,
      login: input.login,
      role: input.role,
    })
    return c.json(created, 201)
  })

  app.post('/host/rooms/:id/members', async c => {
    const admitted: AdmitResponse = admit(db, c.req.param('id'), await body(c, schemas.admit))
    return c.json(admitted, 201)
  })

  app.delete('/host/rooms/:id/members/:login', c => {
    kick(db, c.req.param('id'), c.req.param('login'))
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
    await next()
  }
  app.use('/v1/*', requireMember)

  // A session token opens its own room only; any other looks absent.
  app.use('/v1/rooms/:id/*', async (c, next) => {
    if (c.req.param('id') !== c.get('caller').roomId) throw new HttpError(404, 'no such room')
    await next()
  })

  app.get('/v1/me', c => {
    const caller = c.get('caller')
    const me: MeResponse = { login: caller.login, role: caller.role, room: openRoom(db, caller.roomId) }
    return c.json(me)
  })

  app.get('/v1/rooms/:id/snapshot', c => {
    const since = Math.max(0, Number(c.req.query('since') ?? 0) || 0)
    return c.json(snapshot(db, c.get('caller'), since))
  })

  app.post('/v1/rooms/:id/leave', c => {
    const caller = c.get('caller')
    if (leaveRoom(db, caller).isClosed) onRoomClosed(caller.roomId)
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
