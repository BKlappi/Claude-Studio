import type { Register } from 'claude-code'
import { client, isOutOfRoom } from './api'
import { PANE_ID, runRoom, runStudio } from './commands'
import { isHosting } from './hosting'
import { roomPane } from './pane'
import { loadSaved, setAccount } from './state'
import { forgetRoom, startSync } from './sync'
import { readRoot, trackEdits } from './tracking'

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
      argumentHint: 'create | join | list | invite | leave | open | say | task | attach',
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

  on('command.run', { command: 'studio' }, ($, e) => runStudio($, e.args))
  on('command.run', { command: 'room' }, ($, e) => runRoom($, e.args))

  roomPane(on)
  trackEdits(on)
}
