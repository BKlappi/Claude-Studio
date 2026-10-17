import type { EngineInterface, On } from 'claude-code'
import type { LogEntry, PendingJoin, Task, TaskState } from '../protocol/types'
import type { HostingView } from '../types'
import { client } from './api'
import { PANE_ID } from './commands'
import { hostApi } from './hosting'
import { getHosting, getJoining, getJoins, getRoomView, getSync, loadSaved } from './state'
import { refresh } from './sync'

const MARK: Record<TaskState, string> = { open: '○', claimed: '◐', done: '●', blocked: '✕' }
const COLOR: Record<TaskState, 'text' | 'warning' | 'success' | 'error'> = {
  open: 'text',
  claimed: 'warning',
  done: 'success',
  blocked: 'error',
}

// The pane's address line for the host person: how far making the room
// reachable has got.
function hostingLine(hosting: HostingView): { text: string; color: 'text' | 'warning' | 'error' } {
  const via = hosting.provider === null ? '' : ` (${hosting.provider})`
  switch (hosting.phase) {
    case 'starting': return { text: 'starting the room host…', color: 'warning' }
    case 'exposing': return { text: `making the room reachable${via}…`, color: 'warning' }
    case 'resolving': return { text: `starting the tunnel${via} and waiting for its name to resolve: up to a minute…`, color: 'warning' }
    case 'up': return { text: `reachable at ${hosting.address ?? '?'}${via}`, color: 'text' }
    case 'restarting': return { text: `restarting${via}…`, color: 'warning' }
    case 'lost': return { text: hosting.note ?? 'room lost', color: 'error' }
  }
}

function logLine(entry: LogEntry): string {
  if (entry.kind === 'message') return `[${entry.author ?? '?'}]: ${entry.body}`
  return `· ${entry.body}`
}

async function claim($: EngineInterface, task: Task): Promise<void> {
  const saved = await loadSaved($)
  if (saved === null) return
  try {
    await client($, saved).claimTask(task.id)
    // PLAN.md phase 3: a claimed task starts a turn here, after local approval.
    $.ui.toast(`Claimed: ${task.title}`)
  } catch (error) {
    $.ui.toast(`Claim failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  await refresh($)
}

// The host person lets someone in, or not (PLAN.md D6: no proof, or no
// answer about their repo permission).
async function decide($: EngineInterface, request: PendingJoin, isAdmitted: boolean): Promise<void> {
  const api = hostApi($)
  if (api === null) return
  try {
    if (isAdmitted) await api.admit(request.id)
    else await api.refuse(request.id)
    $.ui.toast(isAdmitted ? `Let in: ${request.login}` : `Refused: ${request.login}`)
  } catch (error) {
    $.ui.toast(`Studio: ${error instanceof Error ? error.message : String(error)}`)
  }
  await refresh($)
}

export function roomPane(on: On): void {
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await getRoomView($)
    const state = await getSync($)
    const hosting = await getHosting($)
    const joining = await getJoining($)
    const joins = await getJoins($)

    const line = hosting === null ? null : hostingLine(hosting)
    const hostingLines = hosting !== null && line !== null && (
      <Box flexDirection="column">
        <Text color={line.color} wrap="truncate">{line.text}</Text>
        {hosting.warning !== null && <Text color="warning" wrap="wrap">{hosting.warning}</Text>}
        {/* A lost room's line is its note. */}
        {hosting.note !== null && hosting.phase !== 'lost' && <Text dimColor wrap="wrap">{hosting.note}</Text>}
      </Box>
    )

    if (view === null) {
      const doing = joining === null
        ? ''
        : joining.phase === 'failed' ? 'could not join' : joining.phase === 'waiting' ? 'waiting for the host to let you in' : 'waiting for the address to resolve'
      return (
        <Box flexDirection="column">
          {joining === null && <Text dimColor>Not in a room: /room create, or /room join with an invite link</Text>}
          {joining !== null && (
            <Text color={joining.phase === 'failed' ? 'error' : 'warning'} wrap="wrap">
              {doing}: {joining.address} · {joining.note}
            </Text>
          )}
          {hostingLines}
          {state.error !== null && <Text color="error">{state.error}</Text>}
        </Box>
      )
    }

    // An unverified member was admitted by hand, without GitHub proof.
    const people = view.members.map(member => (member.verified ? member.login : `${member.login} (unverified)`))
    const rows = e.viewport?.rows ?? 24
    const logRoom = Math.max(3, rows - view.tasks.length - 9)

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate">
          {view.room.name}
          {view.room.visibility === 'private' ? ' (private)' : ''}
        </Text>
        <Text dimColor wrap="truncate">
          hosted by {view.room.hostLogin} · {people.join(', ')}
        </Text>
        {hostingLines}
        {joins.map(request => (
          <Box key={`join:${request.id}`} flexDirection="row">
            <Text color="warning" wrap="truncate">
              {request.login} wants in ({request.verified ? 'verified' : 'unverified'}: {request.reason})
            </Text>
            <Button key={`admit:${request.id}`} label="Let in" onPress={() => decide($, request, true)} />
            <Button key={`refuse:${request.id}`} label="Refuse" onPress={() => decide($, request, false)} />
          </Box>
        ))}

        <Text bold>Tasks</Text>
        {view.tasks.length === 0 && <Text dimColor>none yet: /room task "title"</Text>}
        {view.tasks.map(task => (
          <Box key={`task:${task.id}`} flexDirection="row">
            <Text color={COLOR[task.state]} wrap="truncate">
              {MARK[task.state]} {task.title}
              {task.claimedBy === null ? '' : ` · ${task.claimedBy}`}
            </Text>
            {task.state === 'open' && (
              <Button key={`claim:${task.id}`} label="Claim" onPress={() => claim($, task)} />
            )}
          </Box>
        ))}

        <Text bold>Room log</Text>
        {view.log.slice(-logRoom).map(entry => (
          <Text dimColor={entry.kind !== 'message'} wrap="truncate">
            {logLine(entry)}
          </Text>
        ))}
        {state.error !== null && <Text color="error">sync: {state.error}</Text>}
      </Box>
    )
  })
}
