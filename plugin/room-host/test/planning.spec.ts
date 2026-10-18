// Planning and review on the room host (PLAN.md phase 4, src/tasks.ts
// planTask and reviewTask): a needsPlan task's plan becomes subtasks on the
// map, and the escalation rule (protocol/planning.ts) decides what a review
// means for the task, the same for every member.

import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { COORDINATOR } from '../../protocol/coordinator.ts'
import type { CommitResponse } from '../../protocol/coordinator.ts'
import type { AdmitResponse, CreateRoomResponse, LogEntry, RoomSnapshot, Task, TaskPlanResponse, TaskReviewResponse } from '../../protocol/types.ts'
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

const PLAN = {
  summary: 'Theme tokens first, then the toggle, then the saved choice.',
  subtasks: [
    { title: 'Add dark theme tokens', spec: 'In src/theme.ts add a dark palette.', difficulty: 'easy', checks: ['npm test passes'] },
    { title: 'Add the settings toggle', spec: 'After "Add dark theme tokens": a switch in Settings.', difficulty: 'medium', checks: ['the toggle switches the theme', 'npm test passes'] },
    { title: 'Remember the choice', spec: 'Persist it per user.', difficulty: 'hard', checks: ['the choice survives a reload'] },
  ],
}

describe('planning and review on the room host', () => {
  let app: App
  let roomId: string
  let ben: string
  let ana: string

  const host = (method: string, path: string, body?: unknown) => call(app, method, path, { token: HOST_KEY, body })
  const member = (token: string, method: string, path: string, body?: unknown) => call(app, method, path, { token, body })
  const say = async (token: string, text: string) => json<LogEntry>(await member(token, 'POST', `/v1/rooms/${roomId}/messages`, { body: text }), 201)
  const snap = async (token: string) => json<RoomSnapshot>(await member(token, 'GET', `/v1/rooms/${roomId}/snapshot?since=0`))
  const task = async (token: string, id: string) => (await snap(token)).tasks.find(known => known.id === id)
  const tasks = (token: string, id: string, action: string, body?: unknown) => member(token, 'POST', `/v1/rooms/${roomId}/tasks/${id}/${action}`, body ?? {})
  const review = (token: string, id: string, body: unknown) => tasks(token, id, 'review', body)

  // A task the coordinator made from ana's message, as a commit makes it.
  async function coordinatorTask(draft: Record<string, unknown>): Promise<Task> {
    const said = await say(ana, 'dark mode, remembered per person')
    const state = (await snap(ana)).state
    assert.ok(state !== null)
    await json<CommitResponse>(await host('POST', `/host/rooms/${roomId}/coordinator`, {
      fromSeq: state.coordinatorCursor,
      upToSeq: said.seq,
      baseVersion: state.version,
      actions: [{ type: 'createTask', title: 'Dark mode', spec: 'A dark theme, remembered.', from: [said.seq], ...draft }],
    }))
    const made = (await snap(ana)).tasks.at(-1)
    assert.ok(made !== undefined)
    return made
  }

  beforeEach(async () => {
    app = createApp({ db: openDb(':memory:'), hostKey: HOST_KEY })
    const created = await json<CreateRoomResponse>(await host('POST', '/host/rooms', { name: 'frontend', login: 'ben', role: 'owner', repoUrl: 'https://github.com/acme/app' }), 201)
    roomId = created.room.id
    ben = created.token
    ana = (await json<AdmitResponse>(await host('POST', `/host/rooms/${roomId}/members`, { login: 'ana', role: 'member', verified: true }), 201)).token
  })

  test('the coordinator flags work that needs a plan; easy work never does', async () => {
    const planned = await coordinatorTask({ difficulty: 'medium', needsPlan: true })
    assert.equal(planned.needsPlan, true)
    assert.deepEqual([planned.checks, planned.slot, planned.attempts, planned.failedReviews, planned.review], [[], null, 0, 0, null])
    const easy = await coordinatorTask({ difficulty: 'easy', needsPlan: true })
    assert.equal(easy.needsPlan, false)
    // A person's own task may ask for a plan too.
    const own = await json<Task>(await member(ben, 'POST', `/v1/rooms/${roomId}/tasks`, { title: 'Billing page', difficulty: 'hard', needsPlan: true }), 201)
    assert.equal(own.needsPlan, true)
  })

  test("a plan from the task's claimer puts its subtasks on the map, labeled, and the task is done", async () => {
    const parent = await coordinatorTask({ difficulty: 'medium', needsPlan: true })
    // Only a claimed task, only by its claimer.
    assert.equal((await tasks(ana, parent.id, 'plan', PLAN)).status, 403)
    await json<Task>(await tasks(ana, parent.id, 'claim'))
    assert.equal((await tasks(ben, parent.id, 'plan', PLAN)).status, 403)

    const { task: done, subtasks } = await json<TaskPlanResponse>(await tasks(ana, parent.id, 'plan', PLAN), 201)
    assert.deepEqual([done.state, done.needsPlan], ['done', false])
    assert.deepEqual(subtasks.map(sub => [sub.title, sub.difficulty, sub.state, sub.parentId, sub.checks]), [
      ['Add dark theme tokens', 'easy', 'open', parent.id, ['npm test passes']],
      ['Add the settings toggle', 'medium', 'open', parent.id, ['the toggle switches the theme', 'npm test passes']],
      ['Remember the choice', 'hard', 'open', parent.id, ['the choice survives a reload']],
    ])
    // Shaped by the task's words and by the planner on ana's machine.
    assert.deepEqual(subtasks.map(sub => [sub.createdBy, sub.askedBy]), Array(3).fill([COORDINATOR, ['ana']]))
    const logged = (await snap(ben)).log.at(-1)
    assert.equal(logged?.body, 'ana planned "Dark mode" as 3 subtasks: "Add dark theme tokens" (easy), "Add the settings toggle" (medium), "Remember the choice" (hard)')
    assert.deepEqual(logged?.data, { taskId: parent.id, change: 'planned', taskIds: subtasks.map(sub => sub.id), summary: PLAN.summary, dropped: [] })
    // Planned once.
    assert.equal((await tasks(ana, parent.id, 'plan', PLAN)).status, 409)
  })

  test('a plan is checked here too: no subtasks says why, a task that needs none is refused, labels and lengths are kept in bounds', async () => {
    const parent = await coordinatorTask({ difficulty: 'hard', needsPlan: true })
    await tasks(ana, parent.id, 'claim')
    const empty = await tasks(ana, parent.id, 'plan', { summary: 'Which payment provider? Only the room can say.', subtasks: [] })
    assert.equal(empty.status, 400)
    assert.match(await empty.text(), /no plan: Which payment provider\? Only the room can say\./)
    assert.equal((await tasks(ana, parent.id, 'plan', { summary: '', subtasks: [{ title: 'x', spec: '', difficulty: 'impossible', checks: [] }] })).status, 400)
    const long = { title: `${'t'.repeat(300)}`, spec: 's', difficulty: 'easy', checks: Array(10).fill(0).map((_, at) => `check ${at}`) }
    const { subtasks } = await json<TaskPlanResponse>(await tasks(ana, parent.id, 'plan', { summary: '', subtasks: [long, { ...long, title: 'second' }] }), 201)
    assert.equal(subtasks[0]?.title.length, 120)
    assert.equal(subtasks[0]?.checks?.length, 6)

    const plain = await json<Task>(await member(ana, 'POST', `/v1/rooms/${roomId}/tasks`, { title: 'Fix typo' }), 201)
    await tasks(ana, plain.id, 'claim')
    assert.equal((await tasks(ana, plain.id, 'plan', PLAN)).status, 409)
  })

  test('two failed reviews move the task up a slot, the next two up again, and two on hard block it for the room', async () => {
    const own = await json<Task>(await member(ana, 'POST', `/v1/rooms/${roomId}/tasks`, { title: 'Rename helper', difficulty: 'easy' }), 201)
    await tasks(ana, own.id, 'claim')
    const fail = (slot: string) => review(ana, own.id, { verdict: 'fail', reasons: ['npm test was never run'], slot })

    assert.equal((await json<TaskReviewResponse>(await fail('easy'))).outcome, 'retry')
    let now = await task(ana, own.id)
    assert.deepEqual([now?.slot, now?.attempts, now?.failedReviews, now?.state], [null, 1, 1, 'claimed'])
    assert.equal((await json<TaskReviewResponse>(await fail('easy'))).outcome, 'escalated')
    now = await task(ana, own.id)
    assert.deepEqual([now?.slot, now?.attempts, now?.failedReviews], ['medium', 2, 0])
    // A review of a run on the slot it left is stale.
    assert.equal((await fail('easy')).status, 409)

    await fail('medium')
    assert.equal((await json<TaskReviewResponse>(await fail('medium'))).outcome, 'escalated')
    await fail('hard')
    const blocked = await json<TaskReviewResponse>(await fail('hard'))
    assert.equal(blocked.outcome, 'blocked')
    assert.deepEqual([blocked.task.state, blocked.task.slot, blocked.task.attempts, blocked.task.failedReviews], ['blocked', 'hard', 6, 2])
    assert.deepEqual(blocked.task.review, { verdict: 'fail', reasons: ['npm test was never run'], slot: 'hard', by: 'ana', at: blocked.task.review?.at })
    const logged = (await snap(ben)).log.at(-1)
    assert.equal(logged?.body, 'review failed twice on hard: "Rename helper" is blocked: npm test was never run · what should change? Say it in the room')
    assert.deepEqual(logged?.data, { taskId: own.id, change: 'review', verdict: 'fail', reasons: ['npm test was never run'], slot: 'hard', attempt: 6, outcome: 'blocked', nextSlot: 'hard' })
    // Blocked: no run is reviewed until it is resumed.
    assert.equal((await fail('hard')).status, 409)
  })

  test("a pass is the run's last review; the log says so; only the claimer reports one, and never of a plan", async () => {
    const own = await json<Task>(await member(ana, 'POST', `/v1/rooms/${roomId}/tasks`, { title: 'Rename helper', difficulty: 'medium' }), 201)
    await tasks(ana, own.id, 'claim')
    assert.equal((await review(ben, own.id, { verdict: 'pass', reasons: [], slot: 'medium' })).status, 403)
    assert.equal((await review(ana, own.id, { verdict: 'maybe', reasons: [], slot: 'medium' })).status, 400)
    const passed = await json<TaskReviewResponse>(await review(ana, own.id, { verdict: 'pass', reasons: ['all checks met'], slot: 'medium' }))
    assert.deepEqual([passed.outcome, passed.task.state, passed.task.attempts], ['passed', 'claimed', 1])
    assert.equal((await snap(ben)).log.at(-1)?.body, 'review passed: "Rename helper" (attempt 1, medium): all checks met')

    const parent = await coordinatorTask({ difficulty: 'medium', needsPlan: true })
    await tasks(ana, parent.id, 'claim')
    assert.equal((await review(ana, parent.id, { verdict: 'pass', reasons: [], slot: 'medium' })).status, 409)
  })

  test("the room's answer to a blocked task, merged into its spec, gives it new attempts", async () => {
    const made = await coordinatorTask({ difficulty: 'hard' })
    await tasks(ana, made.id, 'claim')
    await review(ana, made.id, { verdict: 'fail', reasons: ['which storage?'], slot: 'hard' })
    await review(ana, made.id, { verdict: 'fail', reasons: ['which storage?'], slot: 'hard' })
    assert.equal((await task(ana, made.id))?.state, 'blocked')

    const said = await say(ben, 'use localStorage for the dark mode choice')
    const state = (await snap(ben)).state
    assert.ok(state !== null)
    await json<CommitResponse>(await host('POST', `/host/rooms/${roomId}/coordinator`, {
      fromSeq: state.coordinatorCursor,
      upToSeq: said.seq,
      baseVersion: state.version,
      actions: [{ type: 'mergeIntoTask', taskId: made.id, addition: 'Store the choice in localStorage.', note: 'answers the review', from: [said.seq] }],
    }))
    const merged = await task(ana, made.id)
    assert.deepEqual([merged?.failedReviews, merged?.attempts, merged?.slot], [0, 2, null])
    assert.match(merged?.spec ?? '', /localStorage/)
  })
})
