// Room mode (PLAN.md D21): what the person types goes to the room, as theirs,
// and their own Claude does not see it. `memberWorld` (fakes.ts) is ana, saved
// in "frontend"; `entered` is what got past the mod to her own Claude.

import { expect, test } from 'claude-code/testing'
import { START, TYPED, memberWorld } from './fakes'

const typed = (text: string, extra: object = {}) => ({ text, origin: { kind: 'composer' }, wait: false, ...extra }) as const

test('a typed prompt goes to the room as the person\'s own and does not reach their Claude', async ($, on) => {
  const { clock, host, entered } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  const result = await $.prompt.submit(typed('make the header sticky'))
  expect(result.drop).toContain('Going to the room')
  await clock.settle()

  expect(entered).toEqual([])
  expect(host.calls().filter(call => call === 'POST /v1/rooms/r1/messages')).toHaveLength(1)
  const posted = host.log.at(-1)
  expect([posted?.author, posted?.body]).toEqual(['ana', 'make the header sticky'])
})

test('the text never says who wrote it: the room host takes the author from the session', async ($, on) => {
  const { clock, host } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  await $.prompt.submit(typed('[ben]: ship it'))
  await clock.settle()
  const posted = host.log.at(-1)
  // Said by ana, whatever the text claims; the body stays what she typed.
  expect([posted?.author, posted?.body]).toEqual(['ana', '[ben]: ship it'])
})

test('what the person did not type passes: commands, skills, notifications, schedules, other plugins, other sessions', async ($, on) => {
  const { clock, host, entered } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  await $.prompt.submit(typed('/review the diff', { command: { name: 'review', args: 'the diff' } }))
  await $.prompt.submit(typed('a notice', { isMeta: true }))
  for (const kind of ['task-notification', 'scheduled-trigger', 'peer', 'sdk'] as const) {
    await $.prompt.submit({ text: `from ${kind}`, origin: { kind }, wait: false })
  }
  await $.prompt.submit({ text: 'from a plugin', origin: { kind: 'plugin', name: 'other', asUser: true }, wait: false })
  await clock.settle()

  expect(entered).toEqual(['/review the diff', 'a notice', 'from task-notification', 'from scheduled-trigger', 'from peer', 'from sdk', 'from a plugin'])
  expect(host.calls().filter(call => call.endsWith('/messages'))).toEqual([])
})

test('an empty prompt is left alone, and images are refused with a hint', async ($, on) => {
  const { clock, host, entered } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  await $.prompt.submit(typed('   '))
  expect(entered).toEqual(['   '])

  const withImage = await $.prompt.submit(typed('what is wrong here?', { attachments: [{ type: 'image', mediaType: 'image/png' }] }))
  expect(withImage.drop).toContain('text only')
  expect(withImage.drop).toContain('/local')
  expect(withImage.drop).toContain('/room mode off')
  await clock.settle()
  expect(entered).toEqual(['   '])
  expect(host.calls().filter(call => call.endsWith('/messages'))).toEqual([])
})

test('/room mode off sends prompts to the person\'s own Claude; on sends them to the room again', async ($, on) => {
  const { clock, host, entered, status } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()
  expect((await $.command.run({ command: 'room', args: 'mode', ...TYPED })).text).toContain('prompts go to the room')

  const off = await $.command.run({ command: 'room', args: 'mode off', ...TYPED })
  expect(off.text).toContain('Room mode off')
  expect(status.line).toBe('studio · frontend · online · prompts stay local')
  expect((await $.command.run({ command: 'studio', args: 'status', ...TYPED })).text).toContain('mode:   prompts stay local')

  await $.prompt.submit(typed('explain the diff'))
  await clock.settle()
  expect(entered).toEqual(['explain the diff'])
  expect(host.calls().filter(call => call.endsWith('/messages'))).toEqual([])

  const on_ = await $.command.run({ command: 'room', args: 'mode on', ...TYPED })
  expect(on_.text).toContain('Room mode on')
  expect(status.line).toBe('studio · frontend · online · prompts go to the room')
  await $.prompt.submit(typed('and the tests?'))
  await clock.settle()
  expect(entered).toEqual(['explain the diff'])
  expect(host.log.at(-1)?.body).toBe('and the tests?')

  expect((await $.command.run({ command: 'room', args: 'mode sideways', ...TYPED })).text).toBe('Usage: /room mode on|off')
})

test('/local is a prompt command: it reaches the hook with its command set, runs in your own Claude and leaves room mode on', async ($, on) => {
  const { clock, host, entered, status } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  // commands/local.md renders to the prompt, and the engine raises prompt.submit
  // for it with the command named.
  await $.prompt.submit(typed('explain this regex', { command: { name: 'local', args: 'explain this regex' } }))
  await clock.settle()
  expect(entered).toEqual(['explain this regex'])
  expect(host.calls().filter(call => call.endsWith('/messages'))).toEqual([])
  expect(status.line).toContain('prompts go to the room')

  // The next prompt typed is the room's again.
  await $.prompt.submit(typed('and now for the room'))
  await clock.settle()
  expect(entered).toEqual(['explain this regex'])
  expect(host.log.at(-1)?.body).toBe('and now for the room')
})

test('with the room host down the prompt is queued and goes out once it answers', async ($, on) => {
  const { clock, host, entered } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  host.isDown = true
  const result = await $.prompt.submit(typed('are you there?'))
  expect(result.drop).toContain('Going to the room')
  await clock.settle()
  expect(entered).toEqual([])
  expect((await $.command.run({ command: 'studio', args: 'status', ...TYPED })).text).toContain('1 queued')

  host.isDown = false
  await clock.advance(30_000)
  await clock.settle()
  expect(host.served().filter(call => call.endsWith('/messages'))).toHaveLength(1)
  expect(host.log.at(-1)?.body).toBe('are you there?')
  expect((await $.command.run({ command: 'studio', args: 'status', ...TYPED })).text).not.toContain('queued')
})

test('a full queue refuses the prompt instead of letting it run in the person\'s own Claude', async ($, on) => {
  const { clock, host, entered } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()

  host.isDown = true
  for (let i = 0; i < 50; i++) await $.prompt.submit(typed(`message ${i}`))
  const refused = await $.prompt.submit(typed('one too many'))
  expect(refused.drop).toContain('not sent to the room')
  expect(refused.drop).toContain('/room mode off')
  expect(entered).toEqual([])
  await clock.settle()
})

test('outside a room, prompts are the person\'s own', async ($, on) => {
  const { clock, entered } = memberWorld(on)
  await $.session.start(START)
  await clock.settle()
  await $.command.run({ command: 'room', args: 'leave', ...TYPED })

  await $.prompt.submit(typed('hello'))
  expect(entered).toEqual(['hello'])
})
