// Model slots as people name them (PLAN.md phase 4, spec "Model slots"): short
// names that mean a full id, and the shape of a room's defaults. Both sides
// read it: the mod expands what a person types, the room host refuses what no
// model id looks like.

import type { ModelSlot, RoomModels } from './types.ts'

export const MODEL_SLOTS: readonly ModelSlot[] = ['hard', 'medium', 'easy']

// What `opus` and the others mean. Full ids, not the engine's own aliases: an
// alias follows whatever the engine's newest model is, a slot should not move
// by itself.
export const MODEL_SHORT_NAMES: Readonly<Record<string, string>> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

// A model id as the engine takes one: letters, digits and the few marks ids
// carry (`claude-haiku-5-5`, Bedrock's `anthropic.claude-…-v1:0`, `…[1m]`).
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,99}$/

export const isModelId = (text: string): boolean => MODEL_ID.test(text)

// The full id for what the person typed: a short name is expanded (any case),
// anything else is kept as typed.
export function fullModelId(text: string): string {
  const typed = text.trim()
  return MODEL_SHORT_NAMES[typed.toLowerCase()] ?? typed
}

// The slots of `value` that hold a model id, nothing else: what a room host
// stored or a person's saved file may carry is checked once, here. Not an
// object: no slots.
export function slotModels(value: unknown): RoomModels {
  const found: RoomModels = {}
  if (typeof value !== 'object' || value === null) return found
  for (const slot of MODEL_SLOTS) {
    const id = (value as Record<string, unknown>)[slot]
    if (typeof id === 'string' && isModelId(id)) found[slot] = id
  }
  return found
}

// Where the model of a slot comes from: the person's own choice for their
// machine, the room's default, or Studio's.
export type ModelSource = 'own' | 'room' | 'default'

// The model of each slot and where it came from: the person's own choice wins,
// then the room's default, then `defaults`.
export function resolveModels(
  defaults: Readonly<Record<ModelSlot, string>>,
  room: RoomModels | null | undefined,
  own: RoomModels,
): { models: Record<ModelSlot, string>; sources: Record<ModelSlot, ModelSource> } {
  const models = { ...defaults }
  const sources: Record<ModelSlot, ModelSource> = { hard: 'default', medium: 'default', easy: 'default' }
  const roomSlots = slotModels(room)
  const ownSlots = slotModels(own)
  for (const slot of MODEL_SLOTS) {
    const mine = ownSlots[slot]
    const theirs = roomSlots[slot]
    if (mine !== undefined) {
      models[slot] = mine
      sources[slot] = 'own'
    } else if (theirs !== undefined) {
      models[slot] = theirs
      sources[slot] = 'room'
    }
  }
  return { models, sources }
}
