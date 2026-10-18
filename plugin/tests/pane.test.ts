// The room pane and the band above the prompt, against a fake room host: a
// member session saved as ana in "frontend" (see memberWorld in fakes.ts).

import { expect, test } from 'claude-code/testing'
import { PANE, START, TYPED, memberWorld } from './fakes'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 5 },
    view: {},
  },
} as const

const keysOf = async (ui: { findAll: (query: { type: string }) => Promise<{ key: string | undefined }[]> }, prefix: string) =>
  (await ui.findAll({ type: 'Button' })).map(button => button.key ?? '').filter(key => key.startsWith(prefix))

test('the pane marks the host and the successors, and lists the tasks mine first', async ($, on) => {
  const { clock } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'studio', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: 'ben (host, online), ana (successor 1, online), cem (unverified, joined), dee (successor 2, joined)' })).toBeDefined()
    expect(await keysOf(ui, 'expand:')).toEqual(['expand:t3', 'expand:t1', 'expand:t2'])
    expect(await ui.find({ type: 'Text', text: /api docs · you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /dark mode · ben/ })).toBeDefined()
    await ui.unmount()
  }
})

test('pressing a task shows its spec, pressing it again hides it', async ($, on) => {
  const { clock } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'studio', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: 'document the /v1 routes' })).toBeUndefined()
    await ui.press({ key: 'expand:t3' })
    expect(await ui.find({ type: 'Text', text: 'document the /v1 routes' })).toBeDefined()
    await ui.press({ key: 'expand:t2' })
    expect(await ui.find({ type: 'Text', text: 'no spec' })).toBeDefined()
    await ui.press({ key: 'expand:t3' })
    await ui.press({ key: 'expand:t2' })
    expect(await ui.find({ type: 'Text', text: 'document the /v1 routes' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'no spec' })).toBeUndefined()
    await ui.unmount()
  }
})

test('only the claimer gets Release, Done and Blocked; only an open task gets Claim', async ($, on) => {
  const { clock } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await keysOf(ui, 'release:')).toEqual(['release:t3'])
  expect(await keysOf(ui, 'done:')).toEqual(['done:t3'])
  expect(await keysOf(ui, 'blocked:')).toEqual(['blocked:t3'])
  expect(await keysOf(ui, 'claim:')).toEqual(['claim:t2'])
  await ui.unmount()
})

test('Done and Blocked change the task with the version the pane saw; Resume undoes Blocked', async ($, on) => {
  const { clock, host, toasts } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  const stateBody = () => host.requests.filter(request => request.call === 'POST /v1/rooms/r1/tasks/t3/state').map(request => request.body)

  await ui.press({ key: 'blocked:t3' })
  expect(stateBody()).toEqual([{ state: 'blocked', version: 3 }])
  expect(toasts).toContain('Blocked: api docs')
  // Blocked: the claimer can pick it up again, not block it twice.
  expect(await keysOf(ui, 'blocked:')).toEqual([])
  expect(await keysOf(ui, 'resume:')).toEqual(['resume:t3'])

  await ui.press({ key: 'resume:t3' })
  expect(stateBody().at(-1)).toEqual({ state: 'claimed', version: 4 })
  expect(toasts).toContain('Resumed: api docs')

  await ui.press({ key: 'done:t3' })
  expect(stateBody().at(-1)).toEqual({ state: 'done', version: 5 })
  expect(toasts).toContain('Done: api docs')
  // Done is final here: no buttons left, and it is no longer "mine" at the top.
  expect(await keysOf(ui, 'release:')).toEqual([])
  expect(await keysOf(ui, 'expand:')).toEqual(['expand:t1', 'expand:t2', 'expand:t3'])
  await ui.unmount()
})

test('Release puts the task back on the map, where anyone can claim it', async ($, on) => {
  const { clock, host, toasts } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  await ui.press({ key: 'release:t3' })
  expect(host.calls()).toContain('POST /v1/rooms/r1/tasks/t3/release')
  expect(toasts).toContain('Released: api docs')
  expect(await keysOf(ui, 'claim:')).toEqual(['claim:t2', 'claim:t3'])
  expect(await keysOf(ui, 'release:')).toEqual([])
  await ui.unmount()
})

test('a task that changed meanwhile says so, and the pane catches up', async ($, on) => {
  const { clock, host, toasts } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  // The host person changed it after the last poll.
  Object.assign(host.tasks[2] ?? {}, { version: 9 })
  await ui.press({ key: 'done:t3' })
  expect(toasts).toContain('Update failed: task changed meanwhile; reload and retry')
  await ui.press({ key: 'done:t3' })
  expect(host.requests.filter(request => request.call.endsWith('/t3/state')).at(-1)?.body).toEqual({ state: 'done', version: 9 })
  await ui.unmount()
})

test('the band says where the room stands while the pane is closed, and steps aside for it', async ($, on) => {
  const { clock, panes, host } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const closed = await $.ui.mount({ plugin: 'studio', surface, ...BAND })
    expect(await closed.find({ type: 'Text', text: 'frontend · prompts go to the room · 1 open · you: 1 claimed · 1 to approve' })).toBeDefined()
    await closed.unmount()

    // Open and placed: the pane says it all.
    panes.push({ id: 'studio-room', title: 'room', isShown: true, isFocused: false, isPlaced: true })
    const open = await $.ui.mount({ plugin: 'studio', surface, ...BAND })
    expect(await open.find({ type: 'Text', text: /frontend/ })).toBeUndefined()
    await open.unmount()

    // Open but too narrow to be placed: the band is back.
    panes.splice(0, panes.length, { id: 'studio-room', title: 'room', isShown: false, isFocused: false, isPlaced: false })
    const narrow = await $.ui.mount({ plugin: 'studio', surface, ...BAND })
    expect(await narrow.find({ type: 'Text', text: /frontend · prompts go to the room · 1 open/ })).toBeDefined()
    await narrow.unmount()
    panes.length = 0
  }

  // A survey holds the band.
  const survey = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await survey.find({ type: 'Text', text: /frontend/ })).toBeUndefined()
  await survey.unmount()

  // Ana lets go of her task meanwhile: the band drops "you" and the open count rises.
  Object.assign(host.tasks[2] ?? {}, { state: 'open', claimedBy: null })
  await clock.advance(3000)
  await clock.settle()
  const later = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...BAND })
  expect(await later.find({ type: 'Text', text: 'frontend · prompts go to the room · 2 open' })).toBeDefined()
  await later.unmount()
})

test('the status line names the room and whether its host answers', async ($, on) => {
  const { clock, status } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()
  expect(status.line).toBe('studio · frontend · online · prompts go to the room')

  const left = await $.command.run({ command: 'room', args: 'leave', ...TYPED })
  expect(left.text).toBe('Left the room.')
  expect(status.line).toBeUndefined()
})

test('presence: who is online and who has only joined, as the room host reports it', async ($, on) => {
  const { clock, host } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /cem \(unverified, joined\)/ })).toBeDefined()

  // Cem is back and Ben's Claude was closed without leaving.
  Object.assign(host.members[2] ?? {}, { isOnline: true })
  Object.assign(host.members[0] ?? {}, { isOnline: false })
  await clock.advance(3000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'ben (host, joined), ana (successor 1, online), cem (unverified, online), dee (successor 2, joined)' })).toBeDefined()
  await ui.unmount()
})

test('the pane counts the batching window down and drops the line once the room host says it is over', async ($, on) => {
  const { clock, host } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  const line = async () => {
    const texts = await ui.findAll({ type: 'Text', text: /coordinator/ })
    return texts.map(found => found.text)
  }
  const steps: unknown[] = [await line()]

  // The next poll (at 3 s) carries a window of 1.5 s; between polls the pane
  // redraws every second on its own.
  host.batch = { closesInMs: 1500 }
  for (const ms of [3000, 1000, 1000]) {
    await clock.advance(ms)
    await clock.settle()
    steps.push(await line())
  }
  // The room host says the window is over, with the poll at 6 s.
  host.batch = null
  await clock.advance(1000)
  await clock.settle()
  steps.push(await line())

  expect(steps).toEqual([
    [],
    ['coordinator reads in 2 s…'],
    ['coordinator reads in 1 s…'],
    ['coordinator is reading…'],
    [],
  ])
  await ui.unmount()
})

test('a task from someone else asks first: Run here, Run in worktree (its branch named) or Not now', async ($, on) => {
  const { clock, toasts } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  // Ana holds t3, which ben made; ben's own t1 and the open t2 ask nothing of her.
  expect(await keysOf(ui, 'run-here:')).toEqual(['run-here:t3'])
  expect(await keysOf(ui, 'run-worktree:')).toEqual(['run-worktree:t3'])
  expect(await keysOf(ui, 'later:')).toEqual(['later:t3'])
  expect(await ui.find({ type: 'Text', text: "ben's task: run it on this machine?" })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'worktree branch: studio/frontend/t3' })).toBeDefined()

  // This machine cannot start it (the kit answers no file or agent calls):
  // the person hears why, and the card asks again (tests/runs.test.ts runs it).
  await ui.press({ key: 'run-worktree:t3' })
  expect(toasts.at(-1)).toMatch(/^Studio: could not run "api docs": /)
  expect(await keysOf(ui, 'run-here:')).toEqual(['run-here:t3'])
  expect(await ui.find({ type: 'Text', text: /^run stopped: could not start: / })).toBeDefined()
  await ui.unmount()
})

test('Not now keeps the task and lets the person ask again', async ($, on) => {
  const { clock } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'desktop', ...PANE })
  await ui.press({ key: 'later:t3' })
  expect(await keysOf(ui, 'run-here:')).toEqual([])
  expect(await keysOf(ui, 'ask:')).toEqual(['ask:t3'])
  // Not asked again for it, and no start buttons of its own either.
  expect(await keysOf(ui, 'start-')).toEqual([])
  // Still hers: Release, Done and Blocked stay.
  expect(await keysOf(ui, 'release:')).toEqual(['release:t3'])

  await ui.press({ key: 'ask:t3' })
  expect(await keysOf(ui, 'run-here:')).toEqual(['run-here:t3'])
  await ui.unmount()
})

test('your own task asks nothing; a task you let go of and claim again asks again', async ($, on) => {
  const { clock, host } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })

  await ui.press({ key: 'run-here:t3' })
  await ui.press({ key: 'release:t3' })
  await ui.press({ key: 'claim:t3' })
  // The answer went with the claim; the card is back.
  expect(await keysOf(ui, 'run-here:')).toEqual(['run-here:t3'])

  // Made by ana herself, from her own request only: no card.
  Object.assign(host.tasks[2] ?? {}, { createdBy: 'ana', askedBy: ['ana'] })
  await clock.advance(3000)
  await clock.settle()
  expect(await keysOf(ui, 'run-here:')).toEqual([])
  expect(await keysOf(ui, 'release:')).toEqual(['release:t3'])
  await ui.unmount()
})

test('the coordinator\'s lines show as its own, its bookkeeping not at all; its tasks always ask', async ($, on) => {
  const { clock, host } = memberWorld(on)
  host.log.push(
    { seq: 2, roomId: 'r1', kind: 'coordinator', author: null, body: 'new task "Dark mode" from ana\'s and ben\'s requests', data: { action: 'createTask' }, at: 2 },
    { seq: 3, roomId: 'r1', kind: 'coordinator', author: null, body: 'read 2 messages', data: { action: 'read', quiet: true }, at: 3 },
  )
  // Ana holds a task the coordinator made from her request and ben's.
  Object.assign(host.tasks[2] ?? {}, { createdBy: '@coordinator', askedBy: ['ana', 'ben'] })
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: '» new task "Dark mode" from ana\'s and ben\'s requests' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /read 2 messages/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: "the coordinator's task (asked by ana, ben): run it on this machine?" })).toBeDefined()

  // From her own request alone, the coordinator's task still asks: it wrote the spec.
  Object.assign(host.tasks[2] ?? {}, { askedBy: ['ana'] })
  host.say('ben', 'ping')
  await clock.advance(3000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: "the coordinator's task (asked by ana): run it on this machine?" })).toBeDefined()
  await ui.unmount()
})

test('/room export writes what the room kept to docs/rooms/<room>.md, room text on one line each', async ($, on) => {
  const { clock, host } = memberWorld(on)
  const written: { path: string; text: string }[] = []
  on('fs.write', ($, e) => {
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  Object.assign(host.tasks[0] ?? {}, { state: 'done', title: 'dark mode\n# not a heading' })
  await $.session.start(START)
  await clock.settle()

  const text = (await $.command.run({ command: 'room', args: 'export', ...TYPED })).text
  expect(text).toBe("Wrote C:/code/app/docs/rooms/frontend.md: the room's goals, decisions, open questions and tasks. It is not committed.")
  // The engine hands the path on in the platform's spelling.
  expect(written[0]?.path.replace(/\\/g, '/')).toBe('C:/code/app/docs/rooms/frontend.md')
  const lines = written[0]?.text.split('\n') ?? []
  expect(lines[0]).toBe('# Room: frontend')
  expect(lines).toContain('### Done')
  expect(lines).toContain('- dark mode # not a heading (ben)')
  expect(lines).toContain('- api docs (ana)')
  expect(lines.filter(line => line.startsWith('# '))).toHaveLength(1)
})

test('the band counts the tasks waiting for the person\'s answer', async ($, on) => {
  const { clock } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  const before = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...BAND })
  expect(await before.find({ type: 'Text', text: /· 1 to approve/ })).toBeDefined()
  await before.unmount()

  await ui.press({ key: 'run-here:t3' })
  const after = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...BAND })
  expect(await after.find({ type: 'Text', text: 'frontend · prompts go to the room · 1 open · you: 1 claimed' })).toBeDefined()
  await after.unmount()
  await ui.unmount()
})
