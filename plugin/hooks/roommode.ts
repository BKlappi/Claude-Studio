import type { EngineInterface, On } from 'claude-code'
import { StudioError } from './api'
import { describe, inBackground } from './processes'
import { isRoomMode, loadSaved, saveSaved } from './state'
import { enqueue, refresh } from './sync'

// Room mode (PLAN.md D21): while the person is in a room, what they type goes
// to the room, author-tagged by the room host from their session token (the
// text never says who wrote it), and their own Claude does not run it.
// `/local <prompt>` (commands/local.md, a prompt command: it reaches this hook
// with `e.command` set, which passes) runs one prompt here anyway; `/room mode
// off` turns room mode off.

const TEXT_ONLY = 'Studio: room mode sends text only, no images or files. /local <prompt> runs this one here, /room mode off types to your own Claude.'
const FAILED = 'Studio: room mode could not send this to the room. /room mode off types to your own Claude again.'

// A hook that fails lets the prompt through, which here would run it in the
// person's own Claude although they believe the room reads it: it fails closed.
export function roomMode(on: On): void {
  on('prompt.submit', async ($, e, next) => {
    // Only what the person typed (Enter, or their phone). A notification, a
    // schedule, a peer session, another plugin's prompt and every slash
    // command or skill pass untouched.
    const isTyped = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!isTyped || e.command !== undefined || e.isMeta === true) return next(e)

    const saved = await loadSaved($)
    if (!isRoomMode(saved) || e.text.trim() === '') return next(e)
    if ((e.attachments?.length ?? 0) > 0) return { drop: TEXT_ONLY }

    try {
      // Queued, then sent now (or with the next poll when one is under way):
      // the hook never waits on the network.
      await enqueue($, { kind: 'say', body: e.text })
    } catch (error) {
      return { drop: `Studio: not sent to the room: ${describe(error)}. /room mode off types to your own Claude.` }
    }
    inBackground($, refresh($))
    return { drop: 'Going to the room (room mode). /local <prompt> runs one prompt here.' }
  }).catch(($, e, next) => (next.called ? next(e) : { drop: FAILED }))
}

// /room mode on|off: persists with the room, so a restart keeps the choice.
export async function setRoomMode($: EngineInterface, isOn: boolean): Promise<void> {
  const saved = await loadSaved($)
  if (saved === null) throw new StudioError(400, 'not in a room')
  await saveSaved($, { ...saved, roomMode: isOn })
  // The band, the pane and the status line say which it is.
  await refresh($)
}
