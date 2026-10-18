// Model slots (PLAN.md phase 4, hooks/models.ts): short names, this person's
// own choice, the room's defaults, and the account check made once a model is
// selected. Ana is in "frontend" (memberWorld); ben hosts it.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { parseModelsArgs } from '../hooks/models'
import { fullModelId, isModelId, resolveModels, slotModels } from '../protocol/models'
import { START, TYPED, memberWorld } from './fakes'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Answer = 'ok' | 'billing' | 'missing' | 'down' | 'slow' | 'refused-by-engine'

// The account beneath the mod: `answers` says what each model id gets back
// from a tiny completion (an id not named answers); `asked` lists the ids tried.
function account(on: On, answers: Record<string, Answer> = {}) {
  const asked: string[] = []
  on('model.complete', ($, e) => {
    asked.push(e.model)
    switch (answers[e.model] ?? 'ok') {
      case 'ok': return { value: { isAnswered: true, text: 'ok', usage: USAGE } }
      case 'billing': return { value: { isAnswered: false, reason: 'api-error', status: 402, error: 'billing_error', usage: USAGE } }
      case 'missing': return { value: { isAnswered: false, reason: 'api-error', status: 404, error: 'model_not_found', usage: USAGE } }
      case 'down': return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE } }
      case 'slow': return { value: { isAnswered: false, reason: 'aborted', usage: USAGE } }
      case 'refused-by-engine': return { deny: `unknown model: ${e.model}` }
    }
  })
  return asked
}

const studio = async ($: Engine, args: string) => (await $.command.run({ command: 'studio', args, ...TYPED })).text ?? ''

test('short names mean full ids, anything else is kept, and what no id looks like is refused', () => {
  expect([fullModelId('opus'), fullModelId('Sonnet'), fullModelId(' haiku '), fullModelId('fable')]).toEqual([
    'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1',
  ])
  expect(fullModelId('claude-opus-4-1')).toBe('claude-opus-4-1')
  expect(fullModelId('anthropic.claude-haiku-v1:0')).toBe('anthropic.claude-haiku-v1:0')
  expect(['claude-haiku-5-5', 'anthropic.claude-sonnet-v1:0', 'claude-sonnet-4-5[1m]'].every(isModelId)).toBe(true)
  expect(['', ' ', 'two words', '-x', 'a;b', 'x'.repeat(101), '$(rm)'].some(isModelId)).toBe(false)
})

test("a slot's model: the person's own choice, else the room's default, else Studio's", () => {
  const defaults = { hard: 'd-hard', medium: 'd-medium', easy: 'd-easy' }
  expect(resolveModels(defaults, null, {})).toEqual({
    models: defaults,
    sources: { hard: 'default', medium: 'default', easy: 'default' },
  })
  expect(resolveModels(defaults, { hard: 'r-hard', medium: 'r-medium' }, { medium: 'own-medium', easy: 'own-easy' })).toEqual({
    models: { hard: 'r-hard', medium: 'own-medium', easy: 'own-easy' },
    sources: { hard: 'room', medium: 'own', easy: 'own' },
  })
  // Whatever a file or a room host holds that is no model id for a slot counts for nothing.
  expect(slotModels({ hard: 'ok-id', medium: 7, easy: 'not an id', extra: 'x' })).toEqual({ hard: 'ok-id' })
  expect(slotModels('hard')).toEqual({})
})

test('the command line: assignments, --room anywhere, reset, check, and what it refuses', () => {
  expect(parseModelsArgs([])).toEqual({ kind: 'show' })
  expect(parseModelsArgs(['hard=opus', 'easy=claude-haiku-5-5'])).toEqual({ kind: 'set', isRoom: false, slots: { hard: 'claude-opus-5-5', easy: 'claude-haiku-5-5' } })
  expect(parseModelsArgs(['--room', 'medium=SONNET'])).toEqual({ kind: 'set', isRoom: true, slots: { medium: 'claude-sonnet-5-5' } })
  expect(parseModelsArgs(['medium=sonnet', '--room'])).toEqual({ kind: 'set', isRoom: true, slots: { medium: 'claude-sonnet-5-5' } })
  expect(parseModelsArgs(['reset'])).toEqual({ kind: 'reset', isRoom: false, slots: ['hard', 'medium', 'easy'] })
  expect(parseModelsArgs(['--room', 'reset', 'easy'])).toEqual({ kind: 'reset', isRoom: true, slots: ['easy'] })
  expect(parseModelsArgs(['check'])).toEqual({ kind: 'check' })
  expect(parseModelsArgs(['hard=opus', 'huge=opus'])).toEqual({ error: expect.stringMatching(/^Not a slot assignment: huge=opus\n/) })
  expect(parseModelsArgs(['hard='])).toEqual({ error: expect.stringMatching(/^Not a slot assignment: hard=/) })
  expect(parseModelsArgs(['hard=a;b'])).toEqual({ error: expect.stringMatching(/^"a;b" is not a model id/) })
  expect(parseModelsArgs(['reset', 'huge'])).toEqual({ error: expect.stringMatching(/^Not a slot: huge/) })
  expect(parseModelsArgs(['check', '--room'])).toEqual({ error: 'check takes nothing more' })
})

test('with no choice made the slots show Studio\'s models, and the account is not asked', async ($, on) => {
  const { clock } = memberWorld(on)
  const asked = account(on)
  await $.session.start(START)
  await clock.settle()
  const text = await studio($, 'models')
  expect(text).toContain('hard:   claude-opus-5-5 (default)\nmedium: claude-sonnet-5-5 (default)\neasy:   claude-haiku-5-5 (default)')
  expect(asked).toEqual([])
})

test("selecting a model asks the account once, keeps the choice, and says the account can use it", async ($, on) => {
  const { clock } = memberWorld(on)
  const asked = account(on)
  await $.session.start(START)
  await clock.settle()

  const text = await studio($, 'models hard=fable easy=haiku')
  expect(asked.sort()).toEqual(['claude-fable-5-1', 'claude-haiku-5-5'])
  expect(text).toContain('hard:   claude-fable-5-1 (your choice; this account can use it)')
  expect(text).toContain('medium: claude-sonnet-5-5 (default)')
  expect(text).not.toContain('Warning')

  // Said again: it is known, nobody is asked, and the choice is still there.
  asked.length = 0
  expect(await studio($, 'models hard=fable')).toContain('hard:   claude-fable-5-1 (your choice; this account can use it)')
  expect(asked).toEqual([])
  expect(await studio($, 'models')).toContain('hard:   claude-fable-5-1 (your choice; this account can use it)')
})

test('a model the account cannot use is kept with a warning, and asked about again only after a few minutes', async ($, on) => {
  const { clock } = memberWorld(on)
  const asked = account(on, { 'claude-fable-5-1': 'billing' })
  await $.session.start(START)
  await clock.settle()

  const text = await studio($, 'models hard=fable')
  expect(text).toContain('hard:   claude-fable-5-1 (your choice; NOT usable on this account: billing: it may need usage credits on this account)')
  expect(text).toContain('Warning: claude-fable-5-1: billing: it may need usage credits on this account. It is kept; runs on it will fail until the account can use it.')
  expect(asked).toEqual(['claude-fable-5-1'])

  await studio($, 'models hard=fable')
  expect(asked).toEqual(['claude-fable-5-1'])
  // After the refusal's few minutes it is asked again (the credits may be there now).
  await clock.advance(6 * 60_000)
  await studio($, 'models hard=fable')
  expect(asked).toEqual(['claude-fable-5-1', 'claude-fable-5-1'])
})

test('no such model, an engine that turns the id away, a busy API and a slow one: each says what it found', async ($, on) => {
  const { clock } = memberWorld(on)
  const asked = account(on, { 'claude-nope-1': 'missing', 'claude-odd-1': 'refused-by-engine', 'claude-busy-1': 'down', 'claude-slow-1': 'slow' })
  await $.session.start(START)
  await clock.settle()

  const text = await studio($, 'models hard=claude-nope-1 medium=claude-odd-1 easy=claude-busy-1')
  expect(text).toContain('Warning: claude-nope-1: this account has no such model.')
  expect(text).toMatch(/Warning: claude-odd-1: .*unknown model: claude-odd-1./)
  // A failure that may clear on its own says nothing about the account: no warning, not kept as a finding.
  expect(text).toContain('claude-busy-1: could not be checked (no answer now (overloaded, 529)). /studio models check tries again.')
  expect(text).toContain('easy:   claude-busy-1 (your choice)')

  const slow = await studio($, 'models easy=claude-slow-1')
  expect(slow).toContain('claude-slow-1: could not be checked (no answer in 30 s)')
  // An unanswered check is not remembered: the next command asks again.
  const before = asked.length
  await studio($, 'models easy=claude-slow-1')
  expect(asked.length).toBe(before + 1)
})

test('check asks about the models in use again, kept or not, and reset takes a choice back', async ($, on) => {
  const { clock } = memberWorld(on)
  const answers: Record<string, Answer> = {}
  const asked = account(on, answers)
  await $.session.start(START)
  await clock.settle()

  await studio($, 'models easy=sonnet')
  asked.length = 0
  const fine = await studio($, 'models check')
  expect(asked.sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
  expect(fine).toContain('Every model in use answers on this account.')

  answers['claude-opus-5-5'] = 'billing'
  const broken = await studio($, 'models check')
  expect(broken).toContain('hard:   claude-opus-5-5 (default; NOT usable on this account: billing:')
  expect(broken).toContain('Warning: claude-opus-5-5:')

  const reset = await studio($, 'models reset easy')
  expect(reset).toContain('easy:   claude-haiku-5-5 (default')
})

test("the room's default is what a member uses until they choose their own", async ($, on) => {
  const { clock, host } = memberWorld(on)
  account(on)
  host.room = { ...host.room, models: { hard: 'claude-fable-5-1', medium: 'claude-opus-5-5' } }
  await $.session.start(START)
  await clock.settle()

  const text = await studio($, 'models')
  expect(text).toContain("hard:   claude-fable-5-1 (the room's default")
  expect(text).toContain("medium: claude-opus-5-5 (the room's default")
  expect(text).toContain('easy:   claude-haiku-5-5 (default)')

  expect(await studio($, 'models medium=sonnet')).toContain('medium: claude-sonnet-5-5 (your choice; this account can use it)')
  // Taking her own back lets the room's default through again.
  expect(await studio($, 'models reset medium')).toContain("medium: claude-opus-5-5 (the room's default")
})

test("the host sets the room's default, an admin may, a member may not; the room host says so", async ($, on) => {
  const { clock, host } = memberWorld(on)
  const asked = account(on)
  await $.session.start(START)
  await clock.settle()

  // Ana is a member.
  expect(await studio($, 'models --room hard=opus')).toBe("studio models: only the host or an admin sets the room's model defaults")
  expect(host.modelSets).toEqual([])

  const ana = host.members.find(member => member.login === 'ana')
  if (ana !== undefined) ana.role = 'admin'
  const text = await studio($, 'models --room hard=fable medium=sonnet')
  expect(host.modelSets).toEqual([{ hard: 'claude-fable-5-1', medium: 'claude-sonnet-5-5' }])
  // The setter's own account is asked about the models, and the room's default shows.
  expect(asked.sort()).toEqual(['claude-fable-5-1', 'claude-sonnet-5-5'])
  expect(text).toContain("hard:   claude-fable-5-1 (the room's default; this account can use it)")

  // One slot taken back leaves the other.
  await studio($, 'models --room reset hard')
  expect(host.modelSets.at(-1)).toEqual({ medium: 'claude-sonnet-5-5' })
  await studio($, 'models --room reset')
  expect(host.modelSets.at(-1)).toEqual({})
  expect(host.room.models).toBeNull()
})

test('a room host from before room defaults is said to be too old', async ($, on) => {
  const { clock, host } = memberWorld(on)
  account(on)
  await $.session.start(START)
  await clock.settle()
  host.hasModelDefaults = false
  expect(await studio($, 'models --room hard=opus')).toBe("studio models: this room's host is too old to keep model defaults")
})

test('outside a room your own choice works, and --room says there is no room', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/code/app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  account(on)
  await $.session.start(START)
  await clock.settle()
  expect(await studio($, 'models hard=opus')).toContain('hard:   claude-opus-5-5 (your choice; this account can use it)')
  expect(await studio($, 'models --room hard=opus')).toMatch(/^studio models: not in a room/)
})
