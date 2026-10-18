// The room's coordinator, run by the host's mod (PLAN.md D10, phase 3): one
// model call per batch of messages, never the host person's own conversation.
//
//   loop: ask the room host for the next batch (it holds the request until the
//         batching window closes) → $.model.complete with the fixed
//         instructions (cached) and the batch → checkActions → commit
//
// A commit names the cursor and state version it read; the room host applies
// it once (protocol/coordinator.ts). So nothing here needs to remember a batch:
// one that failed, or was read twice, is simply read again.

import type { EngineInterface } from 'claude-code'
import { INSTRUCTIONS, batchPrompt, checkActions, contextOf, parseReply } from '../protocol/coordinator'
import type { CoordinatorAction, CoordinatorBatch, CoordinatorUsage } from '../protocol/coordinator'
import { StudioError, hostClient } from './api'
import { describe, inBackground } from './processes'
import { loadModels } from './state'

// The room host holds a batch request this long when nothing is ready.
const WAIT_MS = 25_000
// After an empty answer: a room host that cannot wait is not asked in a spin.
const IDLE_MS = 500
// After the model or the room host failed: 5 s, 15 s, then every minute.
const RETRY_MS = [5_000, 15_000, 60_000]
// A note in the room once the coordinator failed this often in a row.
const NOTE_AFTER = 2
const MODEL_TIMEOUT_MS = 120_000

type HostApi = ReturnType<typeof hostClient>
type Loop = { isStopped: boolean; roomId: string }

// One coordinator per session: the room it hosts. A reload of the mod drops
// it, with the room host (hosting.ts).
let loop: Loop | undefined

export const isCoordinating = (roomId: string) => loop !== undefined && !loop.isStopped && loop.roomId === roomId

export function startCoordinator($: EngineInterface, host: { localUrl: string; hostKey: string }, roomId: string): void {
  stopCoordinator()
  const mine: Loop = { isStopped: false, roomId }
  loop = mine
  inBackground($, run($, hostClient($, host.localUrl, host.hostKey), mine))
}

export function stopCoordinator(): void {
  if (loop !== undefined) loop.isStopped = true
  loop = undefined
}

const NO_USAGE: CoordinatorUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const add = (a: CoordinatorUsage, b: CoordinatorUsage): CoordinatorUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
})

type Outcome = { kind: 'committed' } | { kind: 'moved' } | { kind: 'failed'; why: string }

// What the model makes of one batch, checked, and committed. The model is
// asked twice at most: once more when its answer was no JSON object.
export async function coordinate($: EngineInterface, api: HostApi, batch: CoordinatorBatch, model: string): Promise<Outcome> {
  const prompt = batchPrompt(batch)
  let usage = NO_USAGE
  let reply: unknown = null
  for (let attempt = 1; attempt <= 2 && reply === null; attempt++) {
    const result = await $.model.complete({
      model,
      // The instructions never change: cached across batches.
      system: [{ text: INSTRUCTIONS, cache: true }],
      prompt,
      maxTokens: 4096,
      effort: 'medium',
      timeoutMs: MODEL_TIMEOUT_MS,
    })
    usage = add(usage, result.usage)
    if (!result.isAnswered) {
      const why = result.reason === 'api-error' ? `${result.error}${result.status === null ? '' : `, ${result.status}`}` : result.reason
      return { kind: 'failed', why: `cannot reach its model (${why})` }
    }
    reply = parseReply(result.text)
  }

  const context = contextOf(batch)
  let { actions, dropped } = checkActions(reply, context)
  if (reply === null) {
    // Twice no answer it could read: the room hears it, rather than nothing.
    const from = [...context.authors.keys()]
    const ask: CoordinatorAction = { type: 'reply', text: 'I could not make sense of the last messages. Please say again what you need.', from }
    actions = [ask]
    dropped = ['the model answered twice without a JSON object of actions']
  }
  try {
    await api.commit(batch.room.id, { fromSeq: batch.fromSeq, upToSeq: batch.upToSeq, baseVersion: batch.state.version, actions, dropped, usage })
    return { kind: 'committed' }
  } catch (error) {
    // Read by another coordinator meanwhile (a handover), or sent twice: read again.
    if (error instanceof StudioError && error.status === 409) return { kind: 'moved' }
    throw error
  }
}

const isGone = (error: unknown) => error instanceof StudioError && (error.status === 401 || error.status === 404 || error.status === 410)

async function run($: EngineInterface, api: HostApi, mine: Loop): Promise<void> {
  let failures = 0
  const failed = async (why: string) => {
    failures += 1
    $.ui.log(`Studio: the coordinator ${why}`, { to: 'debug' })
    if (failures === NOTE_AFTER) {
      await api.note(mine.roomId, `the coordinator ${why}: it keeps trying, and nothing said is lost`).catch(() => undefined)
    }
    await $.clock.sleep(RETRY_MS[Math.min(failures, RETRY_MS.length) - 1] ?? 60_000)
  }

  while (!mine.isStopped) {
    let batch: CoordinatorBatch | null
    try {
      batch = (await api.nextBatch(mine.roomId, WAIT_MS)).batch
    } catch (error) {
      // The room is no longer here: closed, or this host is not its host now.
      if (isGone(error)) return
      await failed(`cannot reach the room host (${describe(error)})`)
      continue
    }
    if (mine.isStopped) return
    if (batch === null) {
      await $.clock.sleep(IDLE_MS)
      continue
    }
    try {
      const { medium } = await loadModels($)
      const outcome = await coordinate($, api, batch, medium)
      if (outcome.kind === 'failed') {
        await failed(outcome.why)
        continue
      }
      if (failures >= NOTE_AFTER) await api.note(mine.roomId, 'the coordinator is back').catch(() => undefined)
      failures = 0
    } catch (error) {
      if (isGone(error)) return
      await failed(`could not commit (${describe(error)})`)
    }
  }
}
