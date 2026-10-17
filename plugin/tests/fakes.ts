// The machine beneath the mod, for tests: the network, host commands, child
// processes and a git remote, each answered from the test's own hooks
// (PLAN.md §8 Testing). What a fake does not know looks absent: a URL
// answers 404, a command is not installed.

import type { On } from 'claude-code'

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
  const rooms = (): { id: string; visibility: string; name?: string; sealed?: string; address?: string }[] =>
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
