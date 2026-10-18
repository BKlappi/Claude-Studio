import type { Register } from 'claude-code'
import { client, isOutOfRoom } from './api'
import { PANE_ID, runRoom, runStudio } from './commands'
import { isHosting } from './hosting'
import { roomBand } from './band'
import { leaveAsHost } from './handover'
import { roomPane } from './pane'
import { roomMode } from './roommode'
import { runHooks } from './runs'
import { loadSaved, setAccount } from './state'
import { forgetRoom, startSync } from './sync'
import { readRoot, trackEdits } from './tracking'

// Long enough for a long-poll's answer to leave this machine.
const SESSION_END_GRACE_MS = 400

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'studio',
      description: 'Studio: your GitHub login, status, model slots',
      argumentHint: 'login | status | models',
    })
    await $.command.register({
      name: 'room',
      description: 'Studio rooms: create, join, list, invite, leave, open, say, task',
      argumentHint: 'create | join | list | invite | leave | open | mode | say | task | batch | attach',
    })
    await readRoot($)

    // Back into the room the last session was in, if its host still has it.
    const saved = await loadSaved($)
    if (saved?.isHost === true && !isHosting()) {
      // This session's room host was its child: a restart or a reload of the
      // mod ended it, and the room with it (PLAN.md D15).
      await forgetRoom($)
      $.ui.toast(
        saved.isAttached === true
          ? 'Studio: a reload of the mod forgot the room you attached to (its room host is still running): /room attach again'
          : 'Studio: the room you hosted ended with its room host (a restart or a reload of the mod ends it)',
      )
    } else if (saved !== null) {
      try {
        const me = await client($, saved).me()
        await setAccount($, { login: me.login, role: me.role, hostUrl: saved.hostUrl })
        startSync($)
        void $.ui.open({ id: PANE_ID, title: `room: ${me.room.name}` })
      } catch (error) {
        // Out of the room: forget it. Unreachable: /studio status says so.
        if (isOutOfRoom(error)) await forgetRoom($)
      }
    }

    return next(e)
  })

  // Quitting Claude Code while hosting with others in the room: the room goes
  // to the successor (PLAN.md §5). The hook's bound is 1.5 s, so this asks the
  // room host (on this machine) to say so, and waits a moment for every
  // member's long-poll to hear it; the engine then ends the room host. A /clear
  // or a resume goes on in the same process, the room host with it.
  on('session.end', async ($, e, next) => {
    const isQuitting = e.reason !== 'clear' && e.reason !== 'resume'
    if (isQuitting && isHosting()) {
      try {
        if ((await leaveAsHost($, null)) !== null) await $.clock.sleep(SESSION_END_GRACE_MS)
      } catch {
        // Nobody hears of it: the others notice the host is gone (unplanned).
      }
    }
    return next(e)
  })

  on('command.run', { command: 'studio' }, ($, e) => runStudio($, e.args))
  on('command.run', { command: 'room' }, ($, e) => runRoom($, e.args))

  roomPane(on)
  roomBand(on)
  roomMode(on)
  runHooks(on)
  trackEdits(on)
}
