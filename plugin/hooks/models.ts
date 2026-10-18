// /studio models (PLAN.md phase 4, spec "Model slots"): the three slots, short
// names, the room's defaults and this person's own choice, and a check that the
// account can use a model once it is selected.
//
//   /studio models                         the model of each slot, and where it comes from
//   /studio models hard=opus easy=haiku    this person's own choice (their machine's work)
//   /studio models --room hard=opus        the room's default (the host or an admin)
//   /studio models reset [hard …]          take back own choices (--room: the room's)
//   /studio models check                   ask the account about the ones in use, again
//
// Selecting a model asks the account about it once: one tiny `$.model.complete`
// per new id, the answer kept (a model that works for a week, one the account
// refused for a few minutes). A refusal warns and the choice stays.

import type { EngineInterface } from 'claude-code'
import { MODEL_SHORT_NAMES, MODEL_SLOTS, fullModelId, isModelId } from '../protocol/models'
import type { ModelSource } from '../protocol/models'
import type { ModelSlot, RoomModels } from '../protocol/types'
import { StudioError, client } from './api'
import { describe } from './processes'
import { getRoomView, loadModelChecks, loadOwnModels, loadSaved, resolveSlots, saveModelChecks, saveOwnModels } from './state'
import type { ModelCheck } from './state'
import { refresh } from './sync'

const OK_FOR_MS = 7 * 24 * 60 * 60 * 1000
const REFUSED_FOR_MS = 5 * 60 * 1000
const CHECK_TIMEOUT_MS = 30_000
const CHECK_PROMPT = 'Reply with the word ok.'

// --- what the person typed ---------------------------------------------------

export type ModelsRequest =
  | { kind: 'show' }
  | { kind: 'check' }
  | { kind: 'set'; isRoom: boolean; slots: RoomModels }
  | { kind: 'reset'; isRoom: boolean; slots: ModelSlot[] }

const USAGE = [
  'Use hard=<model> medium=<model> easy=<model> (a full id, or one of: ' + Object.keys(MODEL_SHORT_NAMES).join(', ') + '),',
  '--room to set the room\'s default instead, reset [hard|medium|easy …] to take a choice back, or check.',
].join('\n')

const isSlot = (word: string): word is ModelSlot => (MODEL_SLOTS as readonly string[]).includes(word)

export function parseModelsArgs(words: readonly string[]): ModelsRequest | { error: string } {
  const isRoom = words.includes('--room')
  const rest = words.filter(word => word !== '--room')
  const [first] = rest
  if (first === undefined) return { kind: 'show' }
  if (first === 'check') return rest.length === 1 && !isRoom ? { kind: 'check' } : { error: 'check takes nothing more' }
  if (first === 'reset') {
    const named = rest.slice(1)
    const bad = named.find(word => !isSlot(word))
    if (bad !== undefined) return { error: `Not a slot: ${bad}\nreset takes hard, medium or easy.` }
    return { kind: 'reset', isRoom, slots: named.length === 0 ? [...MODEL_SLOTS] : named.filter(isSlot) }
  }
  const slots: RoomModels = {}
  for (const word of rest) {
    const at = word.indexOf('=')
    const slot = at < 0 ? word : word.slice(0, at)
    const value = at < 0 ? '' : word.slice(at + 1)
    if (!isSlot(slot) || value === '') return { error: `Not a slot assignment: ${word}\n${USAGE}` }
    const id = fullModelId(value)
    if (!isModelId(id)) return { error: `"${value}" is not a model id.\n${USAGE}` }
    slots[slot] = id
  }
  return { kind: 'set', isRoom, slots }
}

// --- the account check ---------------------------------------------------------

export type Checked = { id: string; state: 'ok' | 'refused' | 'unknown'; why: string }

// Why a model call failed, as far as the engine's classification says (a kind
// that may clear on its own says nothing about the account).
function failure(result: { error: string; status: number | null }): { state: 'refused' | 'unknown'; why: string } {
  const at = result.status === null ? '' : `, ${result.status}`
  switch (result.error) {
    case 'model_not_found': return { state: 'refused', why: 'this account has no such model' }
    case 'billing_error': return { state: 'refused', why: 'billing: it may need usage credits on this account' }
    case 'authentication_failed': return { state: 'refused', why: 'this account is not signed in for it' }
    case 'invalid_request': return { state: 'refused', why: `the API refused the request (${result.error}${at})` }
    default: return { state: 'unknown', why: `no answer now (${result.error}${at})` }
  }
}

async function ask($: EngineInterface, id: string): Promise<{ state: Checked['state']; why: string }> {
  try {
    const result = await $.model.complete({ model: id, prompt: CHECK_PROMPT, maxTokens: 16, timeoutMs: CHECK_TIMEOUT_MS })
    if (result.isAnswered) return { state: 'ok', why: '' }
    switch (result.reason) {
      // It answered, with no words in its first 16 tokens: it is there.
      case 'empty-reply': return { state: 'ok', why: '' }
      case 'aborted': return { state: 'unknown', why: `no answer in ${CHECK_TIMEOUT_MS / 1000} s` }
      case 'api-error': return failure(result)
    }
  } catch (error) {
    // The engine turned the id away before any request (not on its list).
    return { state: 'refused', why: describe(error) }
  }
}

// One tiny completion per id the account has not been asked about lately (or
// all of them, `isForced`), in parallel; what it found is kept.
export async function checkModels($: EngineInterface, ids: readonly string[], options: { isForced?: boolean } = {}): Promise<Checked[]> {
  const checks = await loadModelChecks($)
  const now = await $.clock.now()
  const isFresh = (found: ModelCheck | undefined): found is ModelCheck =>
    found !== undefined && now - found.at < (found.ok ? OK_FOR_MS : REFUSED_FOR_MS)
  const unique = [...new Set(ids)]
  const found = await Promise.all(unique.map(async (id): Promise<Checked> => {
    const known = checks[id]
    if (options.isForced !== true && isFresh(known)) return { id, state: known.ok ? 'ok' : 'refused', why: known.why ?? '' }
    return { id, ...(await ask($, id)) }
  }))
  const learned = found.filter(item => item.state !== 'unknown')
  if (learned.length > 0) {
    const next = { ...(await loadModelChecks($)) }
    for (const item of learned) next[item.id] = { ok: item.state === 'ok', why: item.state === 'ok' ? null : item.why, at: now }
    await saveModelChecks($, next)
  }
  return found
}

// --- what it says --------------------------------------------------------------

const SOURCE_WORDS: Record<ModelSource, string> = { own: 'your choice', room: "the room's default", default: 'default' }

// The slots with where each model comes from and what the account check has
// found so far (`checks`: the answers kept; nothing yet says nothing).
export function modelsText(
  models: Readonly<Record<ModelSlot, string>>,
  sources: Readonly<Record<ModelSlot, ModelSource>>,
  checks: Readonly<Record<string, Pick<ModelCheck, 'ok' | 'why'>>>,
): string {
  return MODEL_SLOTS.map(slot => {
    const known = checks[models[slot]]
    const note = known === undefined ? '' : known.ok ? '; this account can use it' : `; NOT usable on this account: ${known.why ?? 'refused'}`
    return `${slot}:`.padEnd(8) + `${models[slot]} (${SOURCE_WORDS[sources[slot]]}${note})`
  }).join('\n')
}

const warnings = (found: readonly Checked[]): string[] =>
  found.filter(item => item.state !== 'ok').map(item =>
    item.state === 'refused'
      ? `Warning: ${item.id}: ${item.why}. It is kept; runs on it will fail until the account can use it.`
      : `${item.id}: could not be checked (${item.why}). /studio models check tries again.`)

// --- the command -----------------------------------------------------------------

async function show($: EngineInterface): Promise<string> {
  const { models, sources } = await resolveSlots($)
  return modelsText(models, sources, await loadModelChecks($))
}

async function inRoom($: EngineInterface) {
  const saved = await loadSaved($)
  const view = await getRoomView($)
  if (saved === null || view === null) throw new StudioError(400, 'not in a room: --room sets the defaults of the room you are in')
  return { saved, view }
}

// The room's defaults as asked: the host or an admin; the room host says no to anyone else.
async function setRoom($: EngineInterface, change: (now: RoomModels) => RoomModels): Promise<void> {
  const { saved, view } = await inRoom($)
  try {
    await client($, saved).setModels(change(view.room.models ?? {}))
  } catch (error) {
    if (error instanceof StudioError && error.status === 404) throw new StudioError(404, "this room's host is too old to keep model defaults")
    throw error
  }
  await refresh($)
}

// `slots` without the named ones.
function without(slots: RoomModels, names: readonly ModelSlot[]): RoomModels {
  const kept: RoomModels = {}
  for (const slot of MODEL_SLOTS) {
    const id = slots[slot]
    if (id !== undefined && !names.includes(slot)) kept[slot] = id
  }
  return kept
}

export async function studioModels($: EngineInterface, words: readonly string[]): Promise<string> {
  const request = parseModelsArgs(words)
  if ('error' in request) return request.error

  if (request.kind === 'show') {
    return `${await show($)}\n(hard=<model> … sets your own; --room hard=<model> … the room's default; reset; check)`
  }

  if (request.kind === 'check') {
    const { models } = await resolveSlots($)
    const lines = warnings(await checkModels($, Object.values(models), { isForced: true }))
    return [await show($), ...(lines.length === 0 ? ['Every model in use answers on this account.'] : lines)].join('\n')
  }

  if (request.kind === 'reset') {
    if (request.isRoom) await setRoom($, now => without(now, request.slots))
    else await saveOwnModels($, without(await loadOwnModels($), request.slots))
    return await show($)
  }

  // set: kept first, then the account is asked about each new id and warned
  const ids = Object.values(request.slots)
  if (request.isRoom) await setRoom($, now => ({ ...now, ...request.slots }))
  else await saveOwnModels($, { ...(await loadOwnModels($)), ...request.slots })
  const found = await checkModels($, ids)
  return [await show($), ...warnings(found)].join('\n')
}
