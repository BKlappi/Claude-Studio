// What the pane says of a task's model slot and reviews, the plan card, and
// `/room task --plan` (PLAN.md phase 4). Ana is in "frontend" (memberWorld);
// she holds t3, ben holds t1, t2 is open.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { detailLines, slotText } from '../hooks/summary'
import type { Task } from '../protocol/types'
import { PANE, START, TYPED, memberWorld } from './fakes'

const keysOf = async (ui: { findAll: (query: { type: string }) => Promise<{ key: string | undefined }[]> }, prefix: string) =>
  (await ui.findAll({ type: 'Button' })).map(button => button.key ?? '').filter(key => key.startsWith(prefix))

const base: Task = {
  id: 't9', roomId: 'r1', title: 'x', spec: '', state: 'open', difficulty: null, claimedBy: null,
  createdBy: 'ben', askedBy: ['ben'], createdAt: 1, updatedAt: 1, version: 1,
}
const room = async ($: Engine, args: string) => (await $.command.run({ command: 'room', args, ...TYPED })).text ?? ''

test("a task's slot: its label's, the one its reviews moved it to, the plan's, and the runs so far", () => {
  expect(slotText(base)).toBe('medium')
  expect(slotText({ ...base, difficulty: 'easy' })).toBe('easy')
  expect(slotText({ ...base, difficulty: 'easy', attempts: 1 })).toBe('easy · 1 run')
  expect(slotText({ ...base, difficulty: 'easy', slot: 'medium', attempts: 3 })).toBe('easy→medium · 3 runs')
  expect(slotText({ ...base, difficulty: 'hard', slot: 'hard' })).toBe('hard')
  expect(slotText({ ...base, difficulty: 'medium', needsPlan: true })).toBe('to plan (hard)')
})

test("a task's open view: where it came from, what done looks like, how its reviews stand", () => {
  expect(detailLines(base, undefined)).toEqual([])
  const parent: Task = { ...base, id: 't1', title: 'dark mode' }
  const sub: Task = {
    ...base, parentId: 't1', checks: ['npm test passes', 'the toggle switches the theme'], difficulty: 'easy', slot: 'medium', attempts: 3, failedReviews: 1,
    review: { verdict: 'fail', reasons: ['no toggle in the diff', 'tests never ran'], slot: 'medium', by: 'ana', at: 1 },
  }
  expect(detailLines(sub, parent)).toEqual([
    'part of "dark mode"',
    'done when:',
    '- npm test passes',
    '- the toggle switches the theme',
    'last review: fail (medium model, by ana): no toggle in the diff; tests never ran',
    '1 of 2 reviews failed on the medium model: one more moves it to hard',
  ])
  expect(detailLines({ ...sub, slot: 'hard', failedReviews: 1 }, undefined).at(-1)).toBe('1 of 2 reviews failed on the hard model: one more blocks it')
  // A plan parent that is gone from the map (done a day ago) is still named.
  expect(detailLines({ ...base, parentId: 't1' }, undefined)).toEqual(['part of "a plan"'])
  expect(detailLines({ ...base, needsPlan: true }, undefined)).toEqual(["needs a plan: whoever claims it has Studio's planner split it into subtasks"])
  expect(detailLines({ ...base, state: 'done', failedReviews: 1 }, undefined)).toEqual([])
})

test('the pane puts the slot and the runs on each open task, and the reviews in its open view', async ($, on) => {
  const { clock, host } = memberWorld(on)
  Object.assign(host.tasks[2] ?? {}, {
    difficulty: 'easy', slot: 'medium', attempts: 3, failedReviews: 1, checks: ['npm test passes'],
    review: { verdict: 'fail', reasons: ['tests never ran'], slot: 'easy', by: 'ana', at: 1 },
  })
  Object.assign(host.tasks[0] ?? {}, { difficulty: 'hard' })
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /api docs · you · easy→medium · 3 runs/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /dark mode · ben · hard/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /login form · medium/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /last review/ })).toBeUndefined()

  await ui.press({ key: 'expand:t3' })
  expect(await ui.find({ type: 'Text', text: '- npm test passes' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'last review: fail (easy model, by ana): tests never ran' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 of 2 reviews failed on the medium model: one more moves it to hard' })).toBeDefined()

  // A finished task shows no slot.
  Object.assign(host.tasks[1] ?? {}, { state: 'done', claimedBy: 'ben' })
  await clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: /login form · medium/ })).toBeUndefined()
  await ui.unmount()
})

test("someone else's task that needs a plan is a card that offers to plan it here", async ($, on) => {
  const { clock, host } = memberWorld(on)
  Object.assign(host.tasks[2] ?? {}, { needsPlan: true, difficulty: 'medium' })
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  // Ben's task, Ana claimed it: a card, with one way to plan and one to wait.
  expect(await ui.find({ type: 'Text', text: /ben's task: plan it here\? Studio's planner reads this checkout and splits the task into subtasks; it changes nothing\./ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /run it on this machine\?/ })).toBeUndefined()
  expect(await keysOf(ui, 'run-')).toEqual([])
  expect(await keysOf(ui, 'plan-')).toEqual(['plan-here:t3'])
  expect(await ui.find({ type: 'Text', text: /api docs · you · to plan \(hard\)/ })).toBeDefined()

  await ui.press({ key: 'later:t3' })
  expect(await ui.find({ type: 'Text', text: 'not planned yet' })).toBeDefined()
  expect(await keysOf(ui, 'ask:')).toEqual(['ask:t3'])
  await ui.unmount()
})

test('her own task that needs a plan has no card, and a button that says plan', async ($, on) => {
  const { clock, host } = memberWorld(on)
  Object.assign(host.tasks[2] ?? {}, { needsPlan: true, createdBy: 'ana', askedBy: ['ana'] })
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await keysOf(ui, 'start-')).toEqual(['start-plan:t3'])
  expect(await ui.find({ type: 'Text', text: /plan it here\?/ })).toBeUndefined()
  await ui.unmount()
})

test('/room task --plan makes a task that needs a plan, right after the title or last, and says so', async ($, on) => {
  const { clock, host } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  expect(await room($, 'task "Dark mode" --plan remembered per person')).toBe(
    "Task added: Dark mode (it needs a plan: whoever claims it has Studio's planner split it into subtasks)",
  )
  expect(await room($, 'task "Docs" mention the --plan flag --plan')).toContain('it needs a plan')
  expect(await room($, 'task "Typo" fix the --plan flag in the readme')).toBe('Task added: Typo')
  const made = host.tasks.slice(3)
  expect(made.map(task => [task.title, task.spec, task.needsPlan])).toEqual([
    ['Dark mode', 'remembered per person', true],
    ['Docs', 'mention the --plan flag', true],
    ['Typo', 'fix the --plan flag in the readme', undefined],
  ])
  // What it sends: the flag only when asked for.
  expect(host.requests.filter(request => request.call.endsWith('/tasks')).map(request => request.body)).toEqual([
    { title: 'Dark mode', spec: 'remembered per person', needsPlan: true },
    { title: 'Docs', spec: 'mention the --plan flag', needsPlan: true },
    { title: 'Typo', spec: 'fix the --plan flag in the readme' },
  ])
})
