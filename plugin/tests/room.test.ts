// The mod against a fake room host: this test's hooks answer what the mod
// asks of the engine (store, clock, http.fetch, ui), and the fake host's
// routes answer its requests.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { MeResponse, Room, RoomSnapshot } from '../protocol/types'

const SAVED = { hostUrl: 'http://127.0.0.1:9', roomId: 'r1', token: 'token-1', login: 'ana' }
const ROOM: Room = { id: 'r1', name: 'frontend', visibility: 'open', repoUrl: null, hostLogin: 'ben', createdAt: 0 }
const ME: MeResponse = { login: 'ana', role: 'member', room: ROOM }

const SNAPSHOT: RoomSnapshot = {
  room: ROOM,
  members: [
    { login: 'ben', role: 'owner', verified: true, joinedAt: 1 },
    { login: 'ana', role: 'member', verified: true, joinedAt: 2 },
    { login: 'cem', role: 'member', verified: false, joinedAt: 3 },
  ],
  tasks: [
    { id: 't1', roomId: 'r1', title: 'dark mode', spec: '', state: 'claimed', difficulty: null, claimedBy: 'ben', createdBy: 'ben', createdAt: 1, updatedAt: 1, version: 2 },
    { id: 't2', roomId: 'r1', title: 'login form', spec: '', state: 'open', difficulty: null, claimedBy: null, createdBy: 'ben', createdAt: 2, updatedAt: 2, version: 1 },
  ],
  log: [{ seq: 1, roomId: 'r1', kind: 'message', author: 'ben', body: 'hello', data: null, at: 1 }],
  statusText: 'room: frontend | v0\ndoing: -\ntouching: -\ndecided: -\nplanned: -\nblocked: -',
  cursor: 1,
}

type Answer = { status: number; body: unknown }
type Route = (method: string, path: string) => Answer | undefined

const ok = (body: unknown): Answer => ({ status: 200, body })

// The world beneath the mod. `route` answers the room host's paths; anything
// it leaves out answers 404.
function world(on: On, route: Route) {
  const requests: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  mock.store(on, { room: SAVED })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/code/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', ($, e) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.slice(SAVED.hostUrl.length)
    requests.push(`${method} ${path} ${e.init?.headers?.authorization ?? '-'}`)
    const answer = route(method, path) ?? { status: 404, body: { error: 'no such route' } }
    return {
      value: {
        status: answer.status,
        ok: answer.status < 400,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify(answer.body),
      },
    }
  })
  return { clock, requests, toasts }
}

const START = { cwd: 'C:/code/app', surface: 'terminal', isInteractive: true } as const
// A command the person typed at the prompt, on the main screen.
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

// What the mod remembers about its room, as /studio status says it.
async function status($: Engine) {
  return (await $.command.run({ command: 'studio', args: 'status', ...TYPED })).text
}
const PANE = {
  component: 'Pane',
  requestId: 'studio-room',
  props: {
    title: 'room',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const roomHost: Route = (method, path) => {
  if (path === '/v1/me') return ok(ME)
  if (path.startsWith('/v1/rooms/r1/snapshot')) return ok(SNAPSHOT)
  if (method === 'POST' && path === '/v1/rooms/r1/tasks/t2/claim') return ok({ ...SNAPSHOT.tasks[1], state: 'claimed', claimedBy: 'ana' })
  if (method === 'POST' && path === '/v1/rooms/r1/leave') return ok({ ok: true })
  return undefined
}

test('back in the saved room at session start, drawn in the pane', async ($, on) => {
  const { clock, requests } = world(on, roomHost)
  await $.session.start(START)
  await clock.settle()

  expect(requests).toContain('GET /v1/me Bearer token-1')
  expect(requests).toContain('GET /v1/rooms/r1/snapshot?since=0 Bearer token-1')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'studio', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: 'frontend' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'hosted by ben · ben, ana, cem (unverified)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'dark mode · ben' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '[ben]: hello' })).toBeDefined()
    expect(await ui.find({ key: 'claim:t1' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Claim in the pane claims through the room host', async ($, on) => {
  const { clock, requests, toasts } = world(on, roomHost)
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  await ui.press({ key: 'claim:t2' })
  expect(requests).toContain('POST /v1/rooms/r1/tasks/t2/claim Bearer token-1')
  expect(toasts).toContain('Claimed: login form')
  await ui.unmount()
})

test('a closed room is forgotten', async ($, on) => {
  const { clock, toasts } = world(on, (method, path) =>
    path.startsWith('/v1/rooms/r1/snapshot') ? { status: 410, body: { error: 'the room is closed' } } : roomHost(method, path),
  )
  await $.session.start(START)
  await clock.settle()

  expect(toasts).toContain('Studio: the room is closed')
  expect(await status($)).toBe('Not in a room.')
})

test('a session the host no longer knows is forgotten at start', async ($, on) => {
  const { clock, requests } = world(on, () => ({ status: 401, body: { error: 'not in this room: join it again' } }))
  await $.session.start(START)
  await clock.settle()

  expect(requests).toEqual(['GET /v1/me Bearer token-1'])
  expect(await status($)).toBe('Not in a room.')
})

test('/room leave tells the host, then forgets the room', async ($, on) => {
  const { clock, requests } = world(on, roomHost)
  await $.session.start(START)
  await clock.settle()

  const { text } = await $.command.run({ command: 'room', args: 'leave', ...TYPED })
  expect(text).toBe('Left the room.')
  expect(requests).toContain('POST /v1/rooms/r1/leave Bearer token-1')
  expect(await status($)).toBe('Not in a room.')
})
