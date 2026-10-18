import type { EngineInterface, On } from 'claude-code'
import { needsApproval } from './approval'
import { PANE_ID } from './commands'
import { getAccount, getApprovals, getHosting, getJoins, getRoomView, getSync, isRoomMode, loadSaved } from './state'
import { bandText, connectionText } from './summary'

// The pane draws everything the band says, so the band only shows while the
// pane does not: closed, or too narrow to be placed.
async function isPaneUp($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE_ID && pane.isShown && pane.isPlaced)
  } catch {
    return false
  }
}

// One line above the prompt: `frontend · prompts go to the room · 3 open · you:
// 1 claimed`. Every poll writes the sync state this reads, so it is drawn again
// about as often as the pane is opened and closed is noticed.
export function roomBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A survey holds the band: yield to it.
    if (e.props.hasSurvey) return next(e)
    const view = await getRoomView($)
    if (view === null) return next(e)
    const sync = await getSync($)
    const hosting = await getHosting($)
    const joins = await getJoins($)
    const login = (await getAccount($))?.login ?? null
    const approvals = await getApprovals($)
    const roomMode = isRoomMode(await loadSaved($))
    if (await isPaneUp($)) return next(e)

    const { Text } = $.ui.resolve(e)
    const isFine = connectionText(sync, hosting) === 'online'
    return (
      <Text color={isFine ? undefined : 'warning'} dimColor={isFine} wrap="truncate">
        {bandText(view, login, {
          sync,
          hosting,
          waiting: joins.length,
          toApprove: view.tasks.filter(task => needsApproval(task, login, approvals)).length,
          isRoomMode: roomMode,
        })}
      </Text>
    )
  })
}
