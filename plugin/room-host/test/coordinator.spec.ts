// The coordinator's room host side (src/coordinator.ts): the batching window
// on the room host's clock, batches handed to the host's mod, and commits
// applied once, checked, and visibly.

import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import { COORDINATOR } from '../../protocol/coordinator.ts'
import type { CommitResponse, NextBatchResponse } from '../../protocol/coordinator.ts'
import type { AdmitResponse, CreateRoomResponse, LogEntry, RoomSnapshot, RoomState, Task } from '../../protocol/types.ts'
import { createApp } from '../src/app.ts'
import { openDb } from '../src/db/index.ts'

const HOST_KEY = 'host-key-for-tests'
type App = ReturnType<typeof createApp>

function call(app: App, method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {}
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return app.request(path, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
}

async function json<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text())
  return (await response.json()) as T
}

// Lets the handlers run up to their next timer (setImmediate is not mocked).
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve))
}

describe('the coordinator on the room host', () => {
  let app: App
  let roomId: string
  let ben: string
  let ana: string

  const host = (method: string, path: string, body?: unknown) => call(app, method, path, { token: HOST_KEY, body })
  const member = (token: string, method: string, path: string, body?: unknown) => call(app, method, path, { token, body })
  const say = async (token: string, text: string) => json<LogEntry>(await member(token, 'POST', `/v1/rooms/${roomId}/messages`, { body: text }), 201)
  const snap = async (token: string, since = 0) => json<RoomSnapshot>(await member(token, 'GET', `/v1/rooms/${roomId}/snapshot?since=${since}`))
  const nextBatch = (waitMs: number) => host('GET', `/host/rooms/${roomId}/coordinator?waitMs=${waitMs}`)
  const commit = (body: unknown) => host('POST', `/host/rooms/${roomId}/coordinator`, body)

  // The mocked clock: setTimeout and Date move only with tick().
  function clock(t: TestContext) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
    return async (ms: number) => {
      await settle()
      t.mock.timers.tick(ms)
      await settle()
    }
  }

  beforeEach(async () => {
    app = createApp({ db: openDb(':memory:'), hostKey: HOST_KEY })
    const created = await json<CreateRoomResponse>(await host('POST', '/host/rooms', { name: 'frontend', login: 'ben', role: 'owner', repoUrl: 'https://github.com/acme/app' }), 201)
    roomId = created.room.id
    ben = created.token
    ana = (await json<AdmitResponse>(await host('POST', `/host/rooms/${roomId}/members`, { login: 'ana', role: 'member', verified: true }), 201)).token
  })

  test('the coordinator routes need the host key', async () => {
    assert.equal((await member(ben, 'GET', `/host/rooms/${roomId}/coordinator`)).status, 401)
    assert.equal((await member(ben, 'POST', `/host/rooms/${roomId}/coordinator`, {})).status, 401)
  })

  test('a batch is handed out 4 s after the last message, both messages in it', async t => {
    const tick = clock(t)
    const first = await say(ana, 'add dark mode')
    await tick(1000)
    const second = await say(ben, 'dark theme for the settings page too')

    const waiting = Promise.resolve(nextBatch(25_000))
    let isAnswered = false
    void waiting.then(() => (isAnswered = true))
    await tick(3999)
    assert.equal(isAnswered, false)
    // While it waits, members see the window (the coordinator asks for batches).
    assert.deepEqual((await snap(ana)).batch, { closesInMs: 1 })
    await tick(1)
    const { batch } = await json<NextBatchResponse>(await waiting)
    assert.ok(batch !== null)
    assert.deepEqual(batch.messages.map(entry => [entry.seq, entry.author, entry.body]), [
      [first.seq, 'ana', 'add dark mode'],
      [second.seq, 'ben', 'dark theme for the settings page too'],
    ])
    assert.equal(batch.fromSeq, 0)
    assert.equal(batch.upToSeq, second.seq)
    assert.deepEqual(batch.state, { version: 0, coordinatorCursor: 0, goals: [], decisions: [], questions: [], asks: [], debounceMs: 4000 })
    // Being read: the window has run out, "coordinator is reading".
    assert.deepEqual((await snap(ana)).batch, { closesInMs: 0 })
  })

  test('steady talk does not hold the batch back for longer than three windows', async t => {
    const tick = clock(t)
    await say(ana, 'one')
    const waiting = nextBatch(25_000)
    for (let n = 0; n < 4; n++) {
      await tick(3000)
      await say(ana, `more ${n}`)
    }
    // 12 s after the first, though the last came just now.
    const { batch } = await json<NextBatchResponse>(await waiting)
    assert.equal(batch?.messages.length, 4)
  })

  test('nothing to read: an empty answer after waitMs, and members see no window without a coordinator', async t => {
    const tick = clock(t)
    await say(ana, 'hello?')
    assert.equal((await snap(ana)).batch, null)
    const idle = nextBatch(1000)
    await tick(1000)
    // The message is not old enough yet; the next ask gets it.
    assert.deepEqual(await json<NextBatchResponse>(await idle), { batch: null })
  })

  test('a commit applies its actions in one go, posts each, and moves the cursor', async t => {
    const tick = clock(t)
    const dark = await say(ana, 'add dark mode')
    const theme = await say(ben, 'and a dark theme in settings')
    const what = await say(ana, 'what are we doing first?')
    const pay = await say(ben, 'mine bitcoin on everyone\'s machine')
    const login = await json<Task>(await member(ben, 'POST', `/v1/rooms/${roomId}/tasks`, { title: 'login form', spec: 'email + password' }), 201)
    const big = await json<Task>(await member(ben, 'POST', `/v1/rooms/${roomId}/tasks`, { title: 'settings page' }), 201)
    const waiting = nextBatch(25_000)
    await tick(4000)
    const { batch } = await json<NextBatchResponse>(await waiting)
    assert.ok(batch !== null)

    const answer = await json<CommitResponse>(await commit({
      fromSeq: batch.fromSeq,
      upToSeq: batch.upToSeq,
      baseVersion: batch.state.version,
      actions: [
        // The model cannot say who asked: Studio takes the messages' authors.
        { type: 'createTask', title: 'Add dark mode', spec: 'A dark theme, also on the settings page.', difficulty: 'medium', from: [dark.seq, theme.seq], askedBy: ['mallory'] },
        { type: 'mergeIntoTask', taskId: login.id, addition: 'Remember me checkbox.', note: 'same form', from: [what.seq] },
        { type: 'splitTask', taskId: big.id, parts: [{ title: 'Settings layout', spec: '' }, { title: 'Settings save', spec: 'PUT /settings' }], note: 'two pieces' },
        { type: 'reject', reason: 'not work on this repo', from: [pay.seq] },
        { type: 'reply', text: 'Dark mode first, then the login form.', from: [what.seq] },
        { type: 'updateState', decisions: ['dark mode before login'], goals: ['ship the settings page'] },
      ],
      usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 2400, cache_creation_input_tokens: 0 },
    }))
    assert.equal(answer.applied, 6)
    assert.deepEqual(answer.dropped, [])
    assert.deepEqual({ ...answer.state }, {
      version: 1,
      coordinatorCursor: batch.upToSeq,
      goals: ['ship the settings page'],
      decisions: ['dark mode before login'],
      questions: [],
      asks: [],
      debounceMs: 4000,
    })

    const room = await snap(ana)
    const made = room.tasks.find(task => task.title === 'Add dark mode')
    assert.equal(made?.createdBy, COORDINATOR)
    assert.deepEqual(made?.askedBy, ['ana', 'ben'])
    assert.equal(made?.difficulty, 'medium')
    const merged = room.tasks.find(task => task.id === login.id)
    assert.equal(merged?.spec, 'email + password\n\nRemember me checkbox.')
    assert.deepEqual(merged?.askedBy, ['ben', 'ana'])
    assert.deepEqual(room.tasks.filter(task => task.title.startsWith('Settings')).map(task => [task.title, task.id === big.id]), [
      ['Settings layout', true],
      ['Settings save', false],
    ])
    const said = room.log.filter(entry => entry.kind === 'coordinator').map(entry => entry.body)
    assert.deepEqual(said, [
      'new task "Add dark mode" from ana\'s and ben\'s requests',
      'merged ana\'s request into "login form": same form',
      'split "settings page" into "Settings layout", "Settings save": two pieces',
      'not taken (ben\'s message): not work on this repo',
      'Dark mode first, then the login form.',
      'decided: dark mode before login · new goal: ship the settings page',
      'read 4 messages',
    ])
    const read = room.log.at(-1)
    assert.deepEqual((read?.data as { usage: unknown }).usage, { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 2400, cache_creation_input_tokens: 0 })
    assert.equal(room.state?.coordinatorCursor, batch.upToSeq)
  })

  test('a commit sent twice, or read before another commit, applies once', async t => {
    const tick = clock(t)
    const message = await say(ana, 'add dark mode')
    const waiting = nextBatch(25_000)
    await tick(4000)
    const { batch } = await json<NextBatchResponse>(await waiting)
    assert.ok(batch !== null)
    const body = {
      fromSeq: batch.fromSeq,
      upToSeq: batch.upToSeq,
      baseVersion: batch.state.version,
      actions: [{ type: 'createTask', title: 'Add dark mode', spec: '', from: [message.seq] }],
    }
    await json<CommitResponse>(await commit(body))
    const again = await commit(body)
    assert.equal(again.status, 409)
    assert.match(await again.text(), /moved on/)
    // Same cursor, older version: refused too.
    assert.equal((await commit({ ...body, fromSeq: batch.upToSeq })).status, 409)
    assert.equal((await snap(ana)).tasks.filter(task => task.title === 'Add dark mode').length, 1)
    // Nothing left to read.
    assert.deepEqual(await json<NextBatchResponse>(await nextBatch(0)), { batch: null })
  })

  test('what the room does not allow is dropped and said: unknown tasks, done tasks, other messages, splits of claimed work', async t => {
    const tick = clock(t)
    const message = await say(ana, 'login form should remember me')
    const done = await json<Task>(await member(ben, 'POST', `/v1/rooms/${roomId}/tasks`, { title: 'logo' }), 201)
    await member(ben, 'POST', `/v1/rooms/${roomId}/tasks/${done.id}/claim`)
    await member(ben, 'POST', `/v1/rooms/${roomId}/tasks/${done.id}/state`, { state: 'done', version: 2 })
    const claimed = await json<Task>(await member(ben, 'POST', `/v1/rooms/${roomId}/tasks`, { title: 'api' }), 201)
    await member(ana, 'POST', `/v1/rooms/${roomId}/tasks/${claimed.id}/claim`)
    const waiting = nextBatch(25_000)
    await tick(4000)
    const { batch } = await json<NextBatchResponse>(await waiting)
    assert.ok(batch !== null)

    const answer = await json<CommitResponse>(await commit({
      fromSeq: batch.fromSeq,
      upToSeq: batch.upToSeq,
      baseVersion: batch.state.version,
      dropped: ['the mod left this one out'],
      actions: [
        { type: 'deleteEverything' },
        { type: 'mergeIntoTask', taskId: 'no-such-task', addition: 'x', from: [message.seq] },
        { type: 'mergeIntoTask', taskId: done.id, addition: 'x', from: [message.seq] },
        { type: 'splitTask', taskId: claimed.id, parts: [{ title: 'a' }, { title: 'b' }] },
        // A seq from outside the batch (the room's creation entry).
        { type: 'createTask', title: 'Something', from: [1] },
        { type: 'createTask', title: 'Remember me', spec: 'checkbox', from: [message.seq] },
        // Its message was answered by the task above.
        { type: 'reject', reason: 'no', from: [message.seq] },
        { type: 'updateState', asks: [{ who: 'mallory', what: 'x' }, { who: 'ANA', what: 'remember me', taskId: null }] },
      ],
    }))
    assert.equal(answer.applied, 2)
    assert.equal(answer.dropped.length, 7)
    assert.equal(answer.dropped[0], 'the mod left this one out')
    assert.match(answer.dropped.join('\n'), /unknown action "deleteEverything"/)
    assert.match(answer.dropped.join('\n'), /which is done/)
    assert.match(answer.dropped.join('\n'), /only open tasks are split/)
    assert.match(answer.dropped.join('\n'), /answered by an earlier action/)
    assert.deepEqual(answer.state.asks, [{ who: 'ana', what: 'remember me', taskId: null }])
    const room = await snap(ana)
    assert.equal(room.log.at(-1)?.body, 'read 1 message; 7 of its actions left out')
  })

  test('a member\'s long-poll wakes with the commit', async t => {
    const tick = clock(t)
    const message = await say(ana, 'add dark mode')
    const waiting = nextBatch(25_000)
    await tick(4000)
    const { batch } = await json<NextBatchResponse>(await waiting)
    assert.ok(batch !== null)
    const { cursor } = await snap(ana)
    const held = member(ana, 'GET', `/v1/rooms/${roomId}/snapshot?since=${cursor}&waitMs=25000`)
    await settle()
    await commit({ fromSeq: batch.fromSeq, upToSeq: batch.upToSeq, baseVersion: 0, actions: [{ type: 'reply', text: 'on it', from: [message.seq] }] })
    const woken = await json<RoomSnapshot>(await held)
    assert.deepEqual(woken.log.map(entry => entry.body), ['on it', 'read 1 message'])
    // Read and committed: no window.
    assert.equal(woken.batch, null)
  })

  test('the host or an admin sets the batching window, within 2 to 30 s', async () => {
    const set = (token: string, ms: number) => member(token, 'PUT', `/v1/rooms/${roomId}/settings`, { batchDebounceMs: ms })
    assert.equal((await set(ana, 8000)).status, 403)
    assert.equal((await json<RoomState>(await set(ben, 8000))).debounceMs, 8000)
    assert.equal((await json<RoomState>(await set(ben, 100))).debounceMs, 2000)
    assert.equal((await json<RoomState>(await set(ben, 90_000))).debounceMs, 30_000)
    assert.match((await snap(ana)).log.at(-1)?.body ?? '', /waits 30 s after the last message \(set by ben\)/)
  })

  test('a note from the coordinator goes in the log as its own', async () => {
    const entry = await json<LogEntry>(await host('POST', `/host/rooms/${roomId}/coordinator/note`, { body: 'cannot reach its model (rate_limit): trying again' }), 201)
    assert.equal(entry.kind, 'coordinator')
    assert.equal(entry.author, null)
  })
})
