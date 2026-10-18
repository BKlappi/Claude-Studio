// A room host that does not answer: the mod backs off, says "reconnecting",
// queues what the person types, and picks up where it was once the host is
// back (a restart keeps the member's token, PLAN.md D15).

import { expect, test } from 'claude-code/testing'
import { PANE, START, TYPED, memberWorld } from './fakes'

const SNAPSHOT = 'GET /v1/rooms/r1/snapshot'

test('polls back off from 3 s to 30 s while the room host is down, and go back to 3 s after one answer', async ($, on) => {
  const { clock, host } = memberWorld(on)
  const polls = () => host.calls().filter(call => call.startsWith(SNAPSHOT)).length
  const after = async (ms: number) => {
    await clock.advance(ms)
    await clock.settle()
  }
  await $.session.start(START)
  await clock.settle()
  expect(polls()).toBe(1)

  host.isDown = true
  // The waits before the 2nd, 3rd, ... poll: 3 s after the answer, then 3, 6, 12, 24, 30, 30 s.
  let expected = 1
  for (const wait of [3000, 3000, 6000, 12000, 24000, 30000, 30000]) {
    await after(wait - 1)
    expect(polls()).toBe(expected)
    await after(1)
    expected += 1
    expect(polls()).toBe(expected)
  }

  host.isDown = false
  await after(30000)
  expect(polls()).toBe(expected + 1)
  // One answer, and it is every 3 s again.
  await after(2999)
  expect(polls()).toBe(expected + 1)
  await after(1)
  expect(polls()).toBe(expected + 2)
})

test('the pane, the status line and /studio status say "reconnecting" and keep the last view', async ($, on) => {
  const { clock, host, status } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /reconnecting/ })).toBeUndefined()

  host.isDown = true
  await clock.advance(3000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /reconnecting… one try failed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cannot reach the room host at http:\/\/127\.0\.0\.1:9/ })).toBeDefined()
  // What was on the map stays.
  expect(await ui.find({ type: 'Text', text: /api docs · you/ })).toBeDefined()
  expect(status.line).toBe('studio · frontend · reconnecting · prompts go to the room')
  const text = (await $.command.run({ command: 'studio', args: 'status', ...TYPED })).text
  expect(text).toMatch(/sync: {3}reconnecting \(1 failed\): cannot reach the room host/)

  await clock.advance(3000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /2 tries failed/ })).toBeDefined()

  host.isDown = false
  await clock.advance(6000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /reconnecting/ })).toBeUndefined()
  expect(status.line).toBe('studio · frontend · online · prompts go to the room')
  await ui.unmount()
})

test('a message and a task typed while the host is down are queued and go out once, in order', async ($, on) => {
  const { clock, host, status } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()
  const run = async (command: string, args: string) => (await $.command.run({ command, args, ...TYPED })).text

  host.isDown = true
  expect(await run('room', 'say hello again')).toMatch(/queued \(1 waiting\)/)
  expect(await run('room', 'task "write docs" for the api')).toMatch(/queued \(2 waiting\)/)
  expect(host.log.map(entry => entry.body)).toEqual(['hello'])
  expect(status.line).toBe('studio · frontend · online · prompts go to the room')

  await clock.advance(3000)
  await clock.settle()
  expect(status.line).toBe('studio · frontend · reconnecting · 2 queued · prompts go to the room')
  expect((await run('studio', 'status'))).toMatch(/reconnecting \(1 failed, 2 queued\)/)

  // The host is back; a third message typed before the next poll waits its turn.
  host.isDown = false
  expect(await run('room', 'say last')).toMatch(/queued \(3 waiting\)/)
  await clock.advance(3000)
  await clock.settle()

  const sent = host.served().filter(call => call.startsWith('POST') && !call.endsWith('/files'))
  expect(sent).toEqual(['POST /v1/rooms/r1/messages', 'POST /v1/rooms/r1/tasks', 'POST /v1/rooms/r1/messages'])
  expect(host.log.map(entry => entry.body)).toEqual(['hello', 'hello again', 'last'])
  expect(host.tasks.at(-1)).toMatchObject({ title: 'write docs', spec: 'for the api' })
  expect(status.line).toBe('studio · frontend · online · prompts go to the room')

  // With nothing waiting, a message goes straight out again.
  expect(await run('room', 'say direct')).toBe('Posted.')
})

test('a queued task the room host refuses for good is dropped with a toast; the rest still goes', async ($, on) => {
  const { clock, host, toasts } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()
  const run = async (command: string, args: string) => (await $.command.run({ command, args, ...TYPED })).text

  host.isDown = true
  await run('room', 'task "  "')
  await run('room', 'say still here')
  host.isDown = false
  await clock.advance(3000)
  await clock.settle()

  expect(toasts).toContain('Studio: dropped a queued task: task needs a title')
  expect(host.log.map(entry => entry.body)).toEqual(['hello', 'still here'])
  expect(host.tasks).toHaveLength(3)
})

test('a full queue says so instead of dropping what came before', async ($, on) => {
  const { clock, host } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()
  const run = async (command: string, args: string) => (await $.command.run({ command, args, ...TYPED })).text

  host.isDown = true
  for (let n = 1; n <= 50; n++) expect(await run('room', `say m${n}`)).toMatch(/queued/)
  expect(await run('room', 'say m51')).toMatch(/50 messages already wait/)
  host.isDown = false
  await clock.advance(3000)
  await clock.settle()
  expect(host.log.map(entry => entry.body).slice(1, 3)).toEqual(['m1', 'm2'])
  expect(host.log).toHaveLength(51)
})

test('a room host restart heals without anyone doing anything: same token, nothing forgotten', async ($, on) => {
  const { clock, host, toasts, status } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /\[ben\]: hello/ })).toBeDefined()

  // The tunnel is up, the room host behind it is not (502), while the others carry on.
  host.proxy = 502
  host.say('ben', 'brb')
  host.tasks.push({ id: 't9', roomId: 'r1', title: 'while you were away', spec: '', state: 'open', difficulty: null, claimedBy: null, createdBy: 'ben', askedBy: ['ben'], createdAt: 5, updatedAt: 5, version: 1 })
  for (const wait of [3000, 3000, 6000]) {
    await clock.advance(wait)
    await clock.settle()
  }
  expect(status.line).toBe('studio · frontend · reconnecting · prompts go to the room')
  expect((await $.command.run({ command: 'studio', args: 'status', ...TYPED })).text).toMatch(/^you: {4}ana · member\nroom: {3}frontend/)

  // Back on the same port, with the same data and the same sessions.
  host.proxy = null
  await clock.advance(12000)
  await clock.settle()

  expect(status.line).toBe('studio · frontend · online · prompts go to the room')
  expect(toasts).toEqual([])
  expect(await ui.find({ type: 'Text', text: /reconnecting/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /while you were away/ })).toBeDefined()
  // What happened meanwhile arrives once, after what was seen before.
  expect(await ui.findAll({ type: 'Text', text: /\[ben\]: / })).toHaveLength(2)
  const tokens = host.requests.filter(request => request.call.startsWith(SNAPSHOT)).map(request => request.token)
  expect(new Set(tokens)).toEqual(new Set(['token-1']))
  // Asked who it was once, at session start; a restart is not a reason to ask again.
  expect(host.calls().filter(call => call === 'GET /v1/me')).toHaveLength(1)
  await ui.unmount()
})

test('a restart that lost the member (401) is the one case that forgets the room', async ($, on) => {
  const { clock, host, toasts } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  host.tokens.clear()
  await clock.advance(3000)
  await clock.settle()
  expect(toasts).toEqual(['Studio: not in this room: join it again'])
  expect((await $.command.run({ command: 'studio', args: 'status', ...TYPED })).text).toBe('Not in a room.')
})
