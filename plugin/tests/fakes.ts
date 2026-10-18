// The machine beneath the mod, for tests: the network, host commands, child
// processes and a git remote, each answered from the test's own hooks
// (PLAN.md §8 Testing). What a fake does not know looks absent: a URL
// answers 404, a command is not installed.

import type { On, UiPane } from 'claude-code'
import { mock } from 'claude-code/testing'
import { afterReview, checkPlan, slotOf } from '../protocol/planning'
import type { Difficulty, LogEntry, Member, Room, Task, TaskState } from '../protocol/types'

export const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
export const START = { cwd: 'C:/code/app', surface: 'terminal', isInteractive: true } as const
export const PANE = {
  component: 'Pane',
  requestId: 'studio-room',
  props: {
    title: 'room',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// --- a room host, seen from a member -------------------------------------------

// The room the member session was saved in (`mock.store` answers it).
export const MEMBER = { hostUrl: 'http://127.0.0.1:9', roomId: 'r1', token: 'token-1', login: 'ana' }

const ROOM: Room = { id: 'r1', name: 'frontend', visibility: 'open', repoUrl: null, hostLogin: 'ben', createdAt: 0 }
const member = (login: string, role: Member['role'], verified: boolean, joinedAt: number, isOnline = true): Member => ({
  login, role, verified, joinedAt, isOnline,
})
const task = (id: string, title: string, spec: string, state: TaskState, claimedBy: string | null, version: number): Task => ({
  id, roomId: 'r1', title, spec, state, difficulty: null, claimedBy, createdBy: 'ben', askedBy: ['ben'], createdAt: 1, updatedAt: 1, version,
})

export type FakeRoomHost = {
  // The request does not get through (the machine is off, the tunnel is gone).
  isDown: boolean
  // A tunnel or proxy answers this status instead of the room host (502 while it restarts).
  proxy: number | null
  // Session tokens it knows, and whose they are.
  tokens: Map<string, string>
  members: Member[]
  tasks: Task[]
  log: LogEntry[]
  // The coordinator's batching window the snapshot reports (null: none open).
  batch: { closesInMs: number } | null
  // The room as the room host has it (a test may bind it to a repo, say).
  room: Room
  // Run reports posted (POST .../tasks/<id>/result), in order.
  results: { taskId: string; body: unknown }[]
  // Plans and reviews posted (phase 4), in order; the rule applied as the
  // room host applies it (protocol/planning.ts).
  plans: { taskId: string; body: unknown }[]
  reviews: { taskId: string; body: unknown; outcome: string }[]
  // The room's model defaults as members set them (PUT .../models), in order:
  // the host or an admin may, a member is refused.
  modelSets: unknown[]
  // A room host from before room defaults: the route is not there.
  hasModelDefaults: boolean
  // A long-poll room host (phase 3): a snapshot with waitMs is held until the
  // log grows or waitMs passes on the test's clock. Off: answered at once,
  // like a room host from before phase 3.
  canWait: boolean
  // Every request that was tried, in order; `reached`: the room host got it.
  requests: { call: string; body: unknown; token: string | null; reached: boolean }[]
  // The requests as `POST /v1/rooms/r1/leave`: all tried, or only those it got.
  calls: () => string[]
  served: () => string[]
  say: (author: string, body: string) => void
}

// The member routes of a room host, answered from the test's own hooks: ben
// hosts, ana (the saved session) and dee are verified, cem is not; ben and ana
// are online, cem and dee only joined. Three tasks, all made by ben: ben has
// one, ana has one, one is open.
export function fakeRoomHost(on: On, clock?: { sleep: (ms: number) => Promise<void> }): FakeRoomHost {
  // Held long-polls, woken by the next log entry.
  let wake: () => void = () => {}
  let news = new Promise<void>(resolve => (wake = resolve))
  const host: FakeRoomHost = {
    isDown: false,
    proxy: null,
    canWait: false,
    room: { ...ROOM },
    results: [],
    plans: [],
    reviews: [],
    modelSets: [],
    hasModelDefaults: true,
    tokens: new Map([[MEMBER.token, MEMBER.login]]),
    members: [
      member('ben', 'owner', true, 1),
      member('ana', 'member', true, 2),
      member('cem', 'member', false, 3, false),
      member('dee', 'member', true, 4, false),
    ],
    tasks: [
      task('t1', 'dark mode', 'switch the theme tokens', 'claimed', 'ben', 2),
      task('t2', 'login form', '', 'open', null, 1),
      task('t3', 'api docs', 'document the /v1 routes', 'claimed', 'ana', 3),
    ],
    log: [],
    batch: null,
    requests: [],
    calls: () => host.requests.map(request => request.call),
    served: () => host.requests.filter(request => request.reached).map(request => request.call),
    say: (author, body) => {
      host.log.push({ seq: host.log.length + 1, roomId: 'r1', kind: 'message', author, body, data: null, at: host.log.length + 1 })
      wake()
      news = new Promise<void>(resolve => (wake = resolve))
    },
  }
  host.say('ben', 'hello')

  const answer = (status: number, body: unknown) => ({
    value: { status, ok: status < 400, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) },
  })
  const refuse = (status: number, error: string) => answer(status, { error })

  on('http.fetch', async ($, e) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.slice(MEMBER.hostUrl.length)
    const token = /^Bearer (.*)$/.exec(e.init?.headers?.authorization ?? '')?.[1] ?? null
    const body = (e.init?.body === undefined ? {} : JSON.parse(e.init.body)) as Record<string, string | number | boolean>
    const tried = { call: `${method} ${path}`, body, token, reached: false }
    host.requests.push(tried)
    if (host.isDown) return { deny: 'connect ECONNREFUSED 127.0.0.1:9' }
    if (host.proxy !== null) return { value: { status: host.proxy, ok: false, headers: {}, text: 'Bad gateway' } }
    tried.reached = true
    const who = token === null ? undefined : host.tokens.get(token)
    if (who === undefined) return refuse(401, 'not in this room: join it again')

    const room = '/v1/rooms/r1'
    const logged = (author: string, text: string) => host.say(author, text)
    if (method === 'GET' && path === '/v1/me') return answer(200, { login: who, role: 'member', room: host.room })
    if (method === 'GET' && path.startsWith(`${room}/snapshot?since=`)) {
      const query = new URLSearchParams(path.slice(path.indexOf('?')))
      const since = Number(query.get('since'))
      const waitMs = Number(query.get('waitMs') ?? 0)
      if (host.canWait && clock !== undefined && waitMs > 0 && since > 0 && host.log.length <= since) {
        await Promise.race([news, clock.sleep(waitMs)])
      }
      return answer(200, {
        canWait: host.canWait,
        room: host.room,
        members: host.members,
        tasks: host.tasks,
        log: host.log.filter(entry => entry.seq > since),
        statusText: 'room: frontend | v0',
        batch: host.batch,
        cursor: host.log.length,
      })
    }
    if (method === 'POST' && path === `${room}/messages`) {
      logged(who, String(body.body))
      return answer(201, host.log.at(-1))
    }
    if (method === 'POST' && path === `${room}/tasks`) {
      const title = String(body.title).trim()
      if (title === '') return refuse(400, 'task needs a title')
      const created = { ...task(`t${host.tasks.length + 1}`, title, String(body.spec ?? ''), 'open', null, 1), ...(body.needsPlan === true ? { needsPlan: true } : {}) }
      host.tasks.push(created)
      return answer(201, created)
    }
    if (method === 'PUT' && path === `${room}/models` && host.hasModelDefaults) {
      const role = host.members.find(candidate => candidate.login === who)?.role
      if (who !== host.room.hostLogin && role !== 'owner' && role !== 'admin') return refuse(403, "only the host or an admin sets the room's model defaults")
      const models = (body.models ?? {}) as unknown as Record<string, string>
      host.modelSets.push(models)
      host.room = { ...host.room, models: Object.keys(models).length === 0 ? null : models }
      logged(who, `${who} set the room's model defaults`)
      return answer(200, host.room)
    }
    if (method === 'POST' && path === `${room}/leave`) return answer(200, { ok: true })
    if (method === 'POST' && path === `${room}/files`) return answer(200, { ok: true })
    const result = /^\/v1\/rooms\/r1\/tasks\/([^/]+)\/result$/.exec(path)
    if (method === 'POST' && result !== null) {
      host.results.push({ taskId: result[1] ?? '', body })
      logged(who, `run of ${result[1]} reported`)
      return answer(201, host.log.at(-1))
    }
    const planned = /^\/v1\/rooms\/r1\/tasks\/([^/]+)\/(plan|review)$/.exec(path)
    const target = planned === null ? undefined : host.tasks.find(candidate => candidate.id === planned[1])
    if (method === 'POST' && planned !== null) {
      if (target === undefined) return refuse(404, 'no such task')
      if (target.claimedBy !== who || target.state !== 'claimed') return refuse(409, 'not a claimed task of yours')
      if (planned[2] === 'plan') {
        const checked = checkPlan(body)
        if (!('plan' in checked)) return refuse(400, `no plan: ${checked.error}`)
        host.plans.push({ taskId: target.id, body })
        const subtasks = checked.plan.subtasks.map((sub, at): Task => ({
          ...task(`t${host.tasks.length + at + 1}`, sub.title, sub.spec, 'open', null, 1),
          difficulty: sub.difficulty,
          checks: sub.checks,
          parentId: target.id,
          askedBy: [...new Set([...target.askedBy, who])],
        }))
        host.tasks.push(...subtasks)
        Object.assign(target, { state: 'done', needsPlan: false, version: target.version + 1 })
        logged(who, `planned ${target.id}`)
        return answer(201, { task: target, subtasks })
      }
      const review = body as unknown as { verdict: 'pass' | 'fail'; reasons: string[]; slot: Difficulty }
      if (review.slot !== slotOf(target)) return refuse(409, 'the task is on another slot now')
      const after = afterReview({ slot: review.slot, failedReviews: target.failedReviews ?? 0 }, review.verdict)
      host.reviews.push({ taskId: target.id, body, outcome: after.outcome })
      Object.assign(target, {
        slot: after.outcome === 'escalated' ? after.slot : (target.slot ?? null),
        attempts: (target.attempts ?? 0) + 1,
        failedReviews: after.failedReviews,
        review: { verdict: review.verdict, reasons: review.reasons, slot: review.slot, by: who, at: 1 },
        state: after.outcome === 'blocked' ? 'blocked' : target.state,
        version: target.version + 1,
      })
      logged(who, `review of ${target.id}: ${after.outcome}`)
      return answer(200, { task: target, outcome: after.outcome })
    }

    const action = /^\/v1\/rooms\/r1\/tasks\/([^/]+)\/(claim|release|state)$/.exec(path)
    const found = action === null ? undefined : host.tasks.find(candidate => candidate.id === action[1])
    if (method !== 'POST' || action === null) return refuse(404, 'no such route')
    if (found === undefined) return refuse(404, 'no such task')
    switch (action[2]) {
      case 'claim':
        if (found.state !== 'open') return refuse(409, 'task is not open')
        Object.assign(found, { state: 'claimed', claimedBy: who, version: found.version + 1 })
        break
      case 'release':
        if (found.claimedBy !== who) return refuse(403, 'only the claimer can release a task')
        Object.assign(found, { state: 'open', claimedBy: null, version: found.version + 1 })
        break
      default:
        if (found.claimedBy !== who && ROOM.hostLogin !== who) return refuse(403, 'only the claimer, the host or an admin changes a task')
        if (found.version !== body.version) return refuse(409, 'task changed meanwhile; reload and retry')
        Object.assign(found, { state: body.state, version: found.version + 1 })
    }
    return answer(200, found)
  })
  return host
}

// A member session beneath the mod: the clock, the saved room, the session and
// the engine's UI, and a room host to talk to. `panes` is what `$.ui.panes()` lists;
// `entered` the prompts that got past the mod to the person's own Claude.
export function memberWorld(on: On) {
  const clock = mock.clock(on)
  mock.store(on, { room: MEMBER })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/code/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const panes: UiPane[] = []
  on('ui.panes', () => ({ value: panes }))
  // The bottom of prompt.submit: the engine entering the prompt.
  const entered: string[] = []
  on('prompt.submit', ($, e) => {
    entered.push(e.text)
    return { text: e.text }
  })
  // The band when the mod passes: the engine's own drawing.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  return { clock, host: fakeRoomHost(on, clock), status: fakeStatus(on), toasts, panes, entered }
}

// --- the status line ----------------------------------------------------------

// What `$.ui.status` set last: the engine's one line per plugin (undefined: cleared).
export function fakeStatus(on: On): { line: string | undefined } {
  const shown: { line: string | undefined } = { line: undefined }
  on('ui.status', ($, e) => {
    shown.line = e.text
    return { value: undefined }
  })
  return shown
}

// --- network ------------------------------------------------------------------

export type Call = { method: string; url: string; body: unknown; authorization: string | null }
// A reply, or `fail`: the request does not get through (ENOTFOUND, ...).
export type Reply = { status: number; body: unknown } | { fail: string }

export const ok = (body: unknown, status = 200): Reply => ({ status, body })

export function fakeNet(on: On, answer: (call: Call) => Reply | undefined): Call[] {
  const calls: Call[] = []
  on('http.fetch', ($, e) => {
    const raw = e.init?.body
    const call: Call = {
      method: e.init?.method ?? 'GET',
      url: e.url,
      body: raw === undefined ? undefined : JSON.parse(raw),
      authorization: e.init?.headers?.authorization ?? null,
    }
    calls.push(call)
    const reply = answer(call) ?? { status: 404, body: { error: `no fake for ${call.method} ${call.url}` } }
    if ('fail' in reply) return { deny: reply.fail }
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
    return { value: { status: reply.status, ok: reply.status < 400, headers: {}, text } }
  })
  return calls
}

// --- host commands ------------------------------------------------------------

export type Ran = { argv: string[]; stdin?: string; env?: Record<string, string>; cwd?: string }
export type RunReply = { exitCode?: number; stdout?: string; stderr?: string }

export function fakeRun(on: On, answer: (ran: Ran) => RunReply | undefined): Ran[] {
  const runs: Ran[] = []
  on('process.run', ($, e) => {
    const ran: Ran = { argv: [...e.argv], stdin: e.init?.stdin, env: e.init?.env, cwd: e.init?.cwd }
    runs.push(ran)
    const reply = answer(ran)
    if (reply === undefined) return { deny: `ENOENT: Command '${e.argv[0]}' not found` }
    return {
      value: { exitCode: 0, stdout: '', stderr: '', ...reply, isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  return runs
}

// --- child processes ----------------------------------------------------------

export type FakeChild = {
  argv: string[]
  env: Record<string, string> | undefined
  say: (text: string, pipe?: 'stdout' | 'stderr') => void
  exit: (code?: number) => void
}

type Piece = { stream: 'stdout' | 'stderr'; text: string } | { exit: number }

// Each spawn becomes a FakeChild that `start` drives (an unknown one exits
// at once, as if it could not run). It runs until the test makes it exit.
export function fakeSpawn(on: On, start: (child: FakeChild) => boolean): FakeChild[] {
  const children: FakeChild[] = []
  on('process.spawn', async function* ($, e) {
    const queue: Piece[] = []
    let wake: (() => void) | null = null
    const push = (piece: Piece) => {
      queue.push(piece)
      wake?.()
      wake = null
    }
    const child: FakeChild = {
      argv: [...e.argv],
      env: e.env,
      say: (text, pipe = 'stdout') => push({ stream: pipe, text }),
      exit: (code = 0) => push({ exit: code }),
    }
    children.push(child)
    if (!start(child)) return { value: { code: 127, signal: null } }
    for (;;) {
      while (queue.length === 0) await new Promise<void>(resolve => (wake = resolve))
      const piece = queue.shift()
      if (piece === undefined) continue
      if ('exit' in piece) return { value: { code: piece.exit, signal: null } }
      yield piece
    }
  })
  return children
}

// --- a git remote ---------------------------------------------------------------

// The studio-rooms branch of `origin`, and the git plumbing directory.ts runs
// against it. `beforePush` may move the branch first (another host won the
// race), which makes that push be rejected.
export function fakeGit(options: { remoteUrl?: string; beforePush?: (remote: GitRemote) => void } = {}) {
  const remote: GitRemote = { head: null, files: new Map(), pushes: [] }
  const blobs = new Map<string, string>()
  const trees = new Map<string, string>()
  const local = new Set<string>()
  const commits = new Map<string, { tree: string; parent: string | null; env: Record<string, string> }>()
  let counter = 0
  // Object ids as git spells them.
  const nextSha = () => (++counter).toString(16).padStart(40, '0')

  const answer = (ran: Ran): RunReply | undefined => {
    const [git, command, ...args] = ran.argv
    if (git !== 'git') return undefined
    switch (command) {
      case 'remote':
        return { stdout: `${options.remoteUrl ?? 'git@github.com:acme/app.git'}\n` }
      case 'ls-remote':
        return remote.head === null ? { exitCode: 2 } : { stdout: `${remote.head}\trefs/heads/studio-rooms\n` }
      case 'cat-file':
        return { exitCode: local.has((args[1] ?? '').replace('^{commit}', '')) ? 0 : 1 }
      case 'fetch': {
        const sha = args.at(-1) ?? ''
        if (!remote.files.has(sha)) return { exitCode: 128, stderr: 'fatal: no such commit' }
        local.add(sha)
        return {}
      }
      case 'show': {
        const [sha = '', file] = (args[0] ?? '').split(':')
        const text = remote.files.get(sha)
        return text === undefined || file !== 'rooms.json' ? { exitCode: 128, stderr: 'fatal: path does not exist' } : { stdout: text }
      }
      case 'hash-object': {
        const sha = nextSha()
        blobs.set(sha, ran.stdin ?? '')
        return { stdout: `${sha}\n` }
      }
      case 'mktree': {
        const sha = nextSha()
        trees.set(sha, /blob \S+/.exec(ran.stdin ?? '')?.[0].slice(5) ?? '')
        return { stdout: `${sha}\n` }
      }
      case 'commit-tree': {
        const sha = nextSha()
        const parent = args.includes('-p') ? args[args.indexOf('-p') + 1] : null
        commits.set(sha, { tree: args[0] ?? '', parent: parent ?? null, env: ran.env ?? {} })
        local.add(sha)
        return { stdout: `${sha}\n` }
      }
      case 'push': {
        options.beforePush?.(remote)
        const [sha = ''] = (args.at(-1) ?? '').split(':')
        const commit = commits.get(sha)
        if (commit === undefined) return { exitCode: 1, stderr: 'error: no such commit' }
        if (commit.parent !== remote.head) {
          return { exitCode: 1, stdout: `!\t${sha}:refs/heads/studio-rooms\t[rejected] (fetch first)\n` }
        }
        remote.head = sha
        remote.files.set(sha, blobs.get(trees.get(commit.tree) ?? '') ?? '')
        remote.pushes.push({ sha, parent: commit.parent, env: commit.env })
        return {}
      }
      default:
        return { exitCode: 1, stderr: `fake git: ${command} not known` }
    }
  }

  // What the branch holds now.
  const rooms = (): { id: string; visibility: string; name?: string; host?: string; sealed?: string; address?: string }[] =>
    remote.head === null ? [] : (JSON.parse(remote.files.get(remote.head) ?? '{"rooms":[]}') as { rooms: [] }).rooms

  // Puts a commit on the branch as another machine would; its id.
  const pushFromElsewhere = (text: string) => {
    const sha = nextSha()
    remote.files.set(sha, text)
    remote.head = sha
    return sha
  }
  return { answer, remote, rooms, pushFromElsewhere }
}

export type GitRemote = {
  head: string | null
  files: Map<string, string>
  pushes: { sha: string; parent: string | null; env: Record<string, string> }[]
}
