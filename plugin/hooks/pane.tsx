import type { EngineInterface, On } from 'claude-code'
import { taskBranch } from '../protocol/branch'
import { successors } from '../protocol/handover'
import type { LogEntry, PendingJoin, Task, TaskState } from '../protocol/types'
import type { HostingView, MemberView, RunChoice, RunView } from '../types'
import { isFromOthers, needsApproval, originText } from './approval'
import { client } from './api'
import { PANE_ID } from './commands'
import { hostApi } from './hosting'
import { describe } from './processes'
import { mayRun, runTask } from './runs'
import {
  getAccount, getApprovals, getExpanded, getHandover, getHosting, getJoining, getJoins, getRoomView, getRuns, getSync, isRoomMode, loadSaved,
  setApproval, toggleExpanded,
} from './state'
import { countdownText, detailLines, handoverText, modeText, slotText } from './summary'
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
  if (entry.kind === 'coordinator') return `» ${entry.body}`
  return `· ${entry.body}`
}

// The coordinator's own bookkeeping ("read 3 messages") stays out of the pane.
const isShown = (entry: LogEntry) =>
  !(entry.kind === 'coordinator' && typeof entry.data === 'object' && entry.data !== null && (entry.data as { quiet?: unknown }).quiet === true)

// Who is in the room: the host and the ones who would take over marked, and
// whether each is here now ("online": a request of theirs reached the room
// host in the last 30 s) or only joined. The successors are the verified
// members whose machine can host, in joining order (protocol/handover.ts).
export function peopleLine(members: readonly MemberView[], hostLogin: string): string {
  let place = 0
  return members
    .map(member => {
      let role: string
      if (member.login === hostLogin) role = 'host'
      else if (!member.verified) role = 'unverified'
      else if (member.canHost === false) role = 'cannot host'
      else {
        place += 1
        role = `successor ${place}`
      }
      return `${member.login} (${role}, ${member.isOnline ? 'online' : 'joined'})`
    })
    .join(', ')
}

// Q7: with others in the room and nobody who could take over, leaving closes it.
export function onlyHostWarning(members: readonly MemberView[], hostLogin: string): string | null {
  if (members.length < 2 || successors(members, hostLogin).length > 0) return null
  return `if ${hostLogin} leaves, the room closes: nobody else here can host it`
}

// The branch a task's worktree would use; null for an id no branch can carry.
function branchOf(roomName: string, task: Task): string | null {
  try {
    return taskBranch(roomName, task.id)
  } catch {
    return null
  }
}

// The tasks the caller holds first, the rest in the room's order.
export function mineFirst(tasks: readonly Task[], login: string | null): Task[] {
  const isMine = (task: Task) => login !== null && task.claimedBy === login && task.state !== 'done'
  return [...tasks.filter(isMine), ...tasks.filter(task => !isMine(task))]
}

// One press on a task: asks the room host, says how it went, and reloads.
async function change(
  $: EngineInterface,
  task: Task,
  says: { done: string; failed: string },
  run: (api: ReturnType<typeof client>) => Promise<unknown>,
): Promise<void> {
  const saved = await loadSaved($)
  if (saved === null) return
  try {
    await run(client($, saved))
    // PLAN.md phase 3: a claimed task starts a turn here, after local approval.
    $.ui.toast(`${says.done}: ${task.title}`)
  } catch (error) {
    $.ui.toast(`${says.failed}: ${describe(error)}`)
  }
  await refresh($)
}

const claim = ($: EngineInterface, task: Task) =>
  change($, task, { done: 'Claimed', failed: 'Claim failed' }, api => api.claimTask(task.id))
const release = ($: EngineInterface, task: Task) =>
  change($, task, { done: 'Released', failed: 'Release failed' }, api => api.releaseTask(task.id))
const setState = ($: EngineInterface, task: Task, state: TaskState, done: string) =>
  change($, task, { done, failed: 'Update failed' }, api => api.setTaskState(task.id, state, task.version))

// The answer to a task's approval card (PLAN.md D23): here or in a worktree
// starts the run (hooks/runs.ts); one that could not start asks again.
async function answer($: EngineInterface, task: Task, choice: RunChoice | null): Promise<void> {
  await setApproval($, task.id, choice)
  if (choice !== 'here' && choice !== 'worktree') return
  await start($, task, choice, true)
}

// Starts a run of the person's task. `isApproval`: from the card, which asks
// again if it cannot start.
async function start($: EngineInterface, task: Task, choice: 'here' | 'worktree', isApproval: boolean): Promise<void> {
  try {
    $.ui.toast(`Studio: ${await runTask($, task, choice)}`)
  } catch (error) {
    if (isApproval) await setApproval($, task.id, null)
    $.ui.toast(`Studio: could not run "${task.title}": ${describe(error)}`)
  }
}

// How the task's run on this machine stands, in a few words.
function runLine(run: RunView): { text: string; color: 'text' | 'warning' | 'error' | 'success' } {
  const where = run.where === 'here' ? 'here' : `in ${run.branch ?? 'its worktree'}`
  // A plan reads the checkout and changes nothing.
  if (run.kind === 'plan' && run.phase !== 'stopped') {
    switch (run.phase) {
      case 'starting': return { text: 'plan: starting…', color: 'warning' }
      case 'running': return { text: `plan: the ${run.slot ?? 'hard'} model is reading the code and splitting the task…`, color: 'warning' }
      case 'reviewing': return { text: 'plan: checking it…', color: 'warning' }
      case 'finished': return { text: run.note, color: 'success' }
    }
  }
  switch (run.phase) {
    case 'starting': return { text: `run: starting ${where} (${run.note})…`, color: 'warning' }
    case 'running': return { text: `run: working ${where}…`, color: 'warning' }
    case 'reviewing': return { text: `run: reviewing the change ${where}…`, color: 'warning' }
    case 'finished': return { text: `run finished ${where}: ${run.note} · Done or Blocked?`, color: 'success' }
    case 'stopped': return { text: `run stopped: ${run.note}`, color: 'error' }
  }
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
    $.ui.toast(`Studio: ${describe(error)}`)
  }
  await refresh($)
}

// The buttons that start a run, by key. A button's closure runs as Studio's
// own code, outside any of its hooks, and an agent started there would be one
// Studio cannot watch (hooks/runs.ts heldSpawn): this hook starts the run in
// its own dispatch instead, and takes the press.
const RUN_PRESS = /^(run-here|run-worktree|plan-here|start-here|start-worktree|start-plan):(.+)$/

async function pressRun($: EngineInterface, kind: string, task: Task): Promise<void> {
  switch (kind) {
    case 'run-here':
    case 'plan-here': return answer($, task, 'here')
    case 'run-worktree': return answer($, task, 'worktree')
    default: return start($, task, kind === 'start-worktree' ? 'worktree' : 'here', false)
  }
}

export function roomPane(on: On): void {
  on('ui.press', { plugin: 'studio' }, async ($, e, next) => {
    const found = RUN_PRESS.exec(e.element)
    const task = found === null ? undefined : (await getRoomView($))?.tasks.find(known => known.id === found[2])
    if (found === null || task === undefined) return next(e)
    await pressRun($, found[1] ?? '', task)
    return { element: e.element }
  }).catch(($, e, next) => (next.called ? { element: e.element } : next(e)))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await getRoomView($)
    const state = await getSync($)
    const hosting = await getHosting($)
    const handover = await getHandover($)
    const joining = await getJoining($)
    const joins = await getJoins($)
    const expanded = await getExpanded($)
    const approvals = await getApprovals($)
    const runs = await getRuns($)
    const login = (await getAccount($))?.login ?? null

    const line = hosting === null ? null : hostingLine(hosting)
    const hostingLines = hosting !== null && line !== null && (
      <Box flexDirection="column">
        <Text color={line.color} wrap="truncate">{line.text}</Text>
        {hosting.warning !== null && <Text color="warning" wrap="wrap">{hosting.warning}</Text>}
        {/* A lost room's line is its note. */}
        {hosting.note !== null && hosting.phase !== 'lost' && <Text dimColor wrap="wrap">{hosting.note}</Text>}
      </Box>
    )

    // Asked only when something is timed (outside a room nothing is).
    const now = view === null && handover === null ? 0 : await $.clock.now()
    const moving = handover === null ? null : <Text color={handover.phase === 'failed' ? 'error' : 'warning'} wrap="wrap">{handoverText(handover, now)}</Text>

    if (view === null) {
      if (moving !== null && joining === null) return <Box flexDirection="column">{moving}</Box>
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

    const isRoom = isRoomMode(await loadSaved($))
    const tasks = mineFirst(view.tasks, login)
    const countdown = countdownText(view.batch, state.lastOkAt, now)
    const lonely = onlyHostWarning(view.members, view.room.hostLogin)
    const rows = e.viewport?.rows ?? 24
    const logRoom = Math.max(3, rows - view.tasks.length - 9)

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate">
          {view.room.name}
          {view.room.visibility === 'private' ? ' (private)' : ''}
        </Text>
        <Text dimColor wrap="wrap">
          {peopleLine(view.members, view.room.hostLogin)}
        </Text>
        {lonely !== null && <Text color="warning" wrap="wrap">{lonely}</Text>}
        {moving}
        <Text dimColor wrap="wrap">
          {modeText(isRoom)}
          {isRoom ? ' · /local <prompt> runs one here · /room mode off' : ' · /room mode on'}
        </Text>
        {hostingLines}
        {state.failures > 0 && (
          <Box flexDirection="column">
            <Text color="warning" wrap="wrap">
              reconnecting… {state.failures === 1 ? 'one try failed' : `${state.failures} tries failed`}
              {state.queued > 0 ? ` · ${state.queued} queued, sent when it answers` : ''}
            </Text>
            {state.error !== null && <Text dimColor wrap="wrap">{state.error}</Text>}
          </Box>
        )}
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
        {tasks.length === 0 && <Text dimColor>none yet: /room task "title"</Text>}
        {tasks.map(task => {
          const isOpen = expanded.includes(task.id)
          const isMine = login !== null && task.claimedBy === login
          const run = runs[task.id]
          return (
            <Box key={`task:${task.id}`} flexDirection="column">
              <Box flexDirection="row">
                <Button key={`expand:${task.id}`} plain onPress={() => toggleExpanded($, task.id)}>
                  <Text color={COLOR[task.state]} wrap="truncate">
                    {isOpen ? '▾' : '▸'} {MARK[task.state]} {task.title}
                    {task.claimedBy === null ? '' : ` · ${isMine ? 'you' : task.claimedBy}`}
                    {task.state === 'done' ? '' : ` · ${slotText(task)}`}
                  </Text>
                </Button>
                {task.state === 'open' && (
                  <Button key={`claim:${task.id}`} label="Claim" onPress={() => claim($, task)} />
                )}
              </Box>
              {isOpen && (
                <Box flexDirection="column">
                  <Text dimColor wrap="wrap">
                    {task.spec.trim() === '' ? 'no spec' : task.spec}
                  </Text>
                  {detailLines(task, view.tasks.find(other => other.id === task.parentId)).map(text => (
                    <Text dimColor wrap="wrap">{text}</Text>
                  ))}
                </Box>
              )}
              {needsApproval(task, login, approvals) && task.needsPlan === true && (
                <Box flexDirection="column">
                  <Text color="warning" wrap="wrap">{originText(task)}: plan it here? Studio's planner reads this checkout and splits the task into subtasks; it changes nothing.</Text>
                  <Box flexDirection="row">
                    <Button key={`plan-here:${task.id}`} label="Plan here" variant="primary" onPress={() => answer($, task, 'here')} />
                    <Button key={`later:${task.id}`} label="Not now" onPress={() => answer($, task, 'later')} />
                  </Box>
                </Box>
              )}
              {needsApproval(task, login, approvals) && task.needsPlan !== true && (
                <Box flexDirection="column">
                  <Text color="warning" wrap="wrap">{originText(task)}: run it on this machine?</Text>
                  <Box flexDirection="row">
                    <Button key={`run-here:${task.id}`} label="Run here" onPress={() => answer($, task, 'here')} />
                    {branchOf(view.room.name, task) !== null && (
                      <Button key={`run-worktree:${task.id}`} label="Run in worktree" variant="primary" onPress={() => answer($, task, 'worktree')} />
                    )}
                    <Button key={`later:${task.id}`} label="Not now" onPress={() => answer($, task, 'later')} />
                  </Box>
                  {branchOf(view.room.name, task) !== null && <Text dimColor wrap="truncate">worktree branch: {branchOf(view.room.name, task)}</Text>}
                </Box>
              )}
              {isMine && approvals[task.id] === 'later' && (
                <Box flexDirection="row">
                  <Text dimColor wrap="truncate">{task.needsPlan === true ? 'not planned yet' : 'not run yet'}</Text>
                  <Button key={`ask:${task.id}`} label={task.needsPlan === true ? 'Plan…' : 'Run…'} onPress={() => answer($, task, null)} />
                </Box>
              )}
              {isMine && run !== undefined && (
                <Text color={runLine(run).color} wrap="truncate">{runLine(run).text}</Text>
              )}
              {/* The person's own task asks nothing; it runs when they say. Again after a stop. Someone else's goes through the card. */}
              {isMine && task.state === 'claimed' && !needsApproval(task, login, approvals) && approvals[task.id] !== 'later' && (run === undefined || run.phase === 'stopped') && (
                <Box flexDirection="row">
                  {task.needsPlan === true ? (
                    <Button key={`start-plan:${task.id}`} label={run === undefined ? 'Plan here' : 'Plan again'} onPress={() => start($, task, 'here', false)} />
                  ) : (
                    <Box flexDirection="row">
                      {(login === null || !isFromOthers(task, login) || mayRun(approvals[task.id], 'here')) && (
                        <Button key={`start-here:${task.id}`} label={run === undefined ? 'Run here' : 'Run again here'} onPress={() => start($, task, 'here', false)} />
                      )}
                      {branchOf(view.room.name, task) !== null && (
                        <Button key={`start-worktree:${task.id}`} label={run === undefined ? 'Run in worktree' : 'Run again in worktree'} onPress={() => start($, task, 'worktree', false)} />
                      )}
                    </Box>
                  )}
                </Box>
              )}
              {isMine && (task.state === 'claimed' || task.state === 'blocked') && (
                <Box flexDirection="row">
                  <Button key={`release:${task.id}`} label="Release" onPress={() => release($, task)} />
                  <Button key={`done:${task.id}`} label="Done" onPress={() => setState($, task, 'done', 'Done')} />
                  {task.state === 'claimed'
                    ? <Button key={`blocked:${task.id}`} label="Blocked" onPress={() => setState($, task, 'blocked', 'Blocked')} />
                    : <Button key={`resume:${task.id}`} label="Resume" onPress={() => setState($, task, 'claimed', 'Resumed')} />}
                </Box>
              )}
            </Box>
          )
        })}

        <Text bold>Room log</Text>
        {view.log.filter(isShown).slice(-logRoom).map(entry => (
          <Text dimColor={entry.kind !== 'message'} wrap="truncate">
            {logLine(entry)}
          </Text>
        ))}
        {countdown !== null && <Text color="warning" wrap="truncate">{countdown}</Text>}
        {state.error !== null && state.failures === 0 && <Text color="error">sync: {state.error}</Text>}
      </Box>
    )
  })
}
