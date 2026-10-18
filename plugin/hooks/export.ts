import type { EngineInterface } from 'claude-code'
import { roomSlug } from '../protocol/branch'
import type { TaskState } from '../protocol/types'
import { pathIn } from './processes'
import { getRoomView } from './state'

// A room closes and is gone (D18). What the person may keep (Q6): a short
// summary in the repo's working tree, `docs/rooms/<room-slug>.md`, from what
// this session saw of the room: goals, decisions, open questions, the tasks.
// It is written, not committed: the person reads it and decides.

const line = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
const items = (list: readonly string[]) => (list.length === 0 ? ['- none'] : list.map(item => `- ${line(item)}`))

const ORDER: { state: TaskState; heading: string }[] = [
  { state: 'done', heading: 'Done' },
  { state: 'claimed', heading: 'In progress' },
  { state: 'blocked', heading: 'Blocked' },
  { state: 'open', heading: 'Open' },
]

// The file's path, once written.
export async function exportRoom($: EngineInterface): Promise<string> {
  const view = await getRoomView($)
  if (view === null) throw new Error('not in a room')
  const state = view.state
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const text = [
    `# Room: ${line(view.room.name)}`,
    '',
    `Exported from Studio on ${day}. Hosted by ${view.room.hostLogin}; in the room: ${view.members.map(member => member.login).join(', ')}.`,
    '',
    '## Goals',
    ...items(state?.goals ?? []),
    '',
    '## Decisions',
    ...items(state?.decisions ?? []),
    '',
    '## Open questions',
    ...items(state?.questions ?? []),
    '',
    '## Tasks',
    ...ORDER.flatMap(({ state: taskState, heading }) => {
      const tasks = view.tasks.filter(task => task.state === taskState)
      if (tasks.length === 0) return []
      return ['', `### ${heading}`, ...tasks.map(task => `- ${line(task.title)}${task.claimedBy === null ? '' : ` (${task.claimedBy})`}`)]
    }),
    '',
  ].join('\n')
  const path = pathIn(await $.session.root(), 'docs', 'rooms', `${roomSlug(view.room.name)}.md`)
  await $.fs.write(path, text)
  return path
}
