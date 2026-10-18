// The long-poll (PLAN.md phase 3): a room host that waits is asked again as
// soon as it answers, and what the person types goes out at once, whether a
// long-poll is held or not.

import { expect, test } from 'claude-code/testing'
import { PANE, START, TYPED, memberWorld } from './fakes'

const snapshots = (calls: string[]) =>
  calls.filter(call => call.startsWith('GET /v1/rooms/r1/snapshot')).map(call => call.slice('GET /v1/rooms/r1/snapshot'.length))

test('a room host that waits is long-polled: the next request goes out as soon as one answers', async ($, on) => {
  const { clock, host } = memberWorld(on)
  host.canWait = true
  await $.session.start(START)
  await clock.settle()
  // The first load is answered at once; the next one is held.
  expect(snapshots(host.calls())).toEqual(['?since=0', '?since=1&waitMs=25000'])

  // Ben says something: the held one answers with it, and the next goes out.
  host.say('ben', 'are you there?')
  await clock.settle()
  expect(snapshots(host.calls())).toEqual(['?since=0', '?since=1&waitMs=25000', '?since=2&waitMs=25000'])
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: '[ben]: are you there?' })).toBeDefined()

  // Nothing for 25 s: an empty answer, and straight on with the next.
  await clock.advance(25_000)
  expect(snapshots(host.calls()).slice(2)).toEqual(['?since=2&waitMs=25000', '?since=2&waitMs=25000'])
  await ui.unmount()
})

test('typing goes out while a long-poll is held, and shows once, not twice', async ($, on) => {
  const { clock, host } = memberWorld(on)
  host.canWait = true
  await $.session.start(START)
  await clock.settle()

  expect((await $.command.run({ command: 'room', args: 'say hi', ...TYPED })).text).toBe('Posted.')
  expect(host.served()).toContain('POST /v1/rooms/r1/messages')
  // A prompt in room mode, too.
  await $.prompt.submit({ text: 'and dark mode please', ...TYPED, wait: false })
  await clock.settle()
  expect(host.log.map(entry => entry.body)).toEqual(['hello', 'hi', 'and dark mode please'])

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', ...PANE })
  // The held poll and the refresh after the command both answered with it.
  expect(await ui.findAll({ type: 'Text', text: '[ana]: hi' })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: '[ana]: and dark mode please' })).toHaveLength(1)
  await ui.unmount()
})

test('a room host from before the long-poll is asked every 3 s, as before', async ($, on) => {
  const { clock, host } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()
  expect(snapshots(host.calls())).toEqual(['?since=0'])
  await clock.advance(3000)
  await clock.advance(3000)
  // It got waitMs and ignored it.
  expect(snapshots(host.calls())).toEqual(['?since=0', '?since=1&waitMs=25000', '?since=1&waitMs=25000'])
})
