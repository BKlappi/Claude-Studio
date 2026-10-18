import type { EngineInterface, On } from 'claude-code'
import { runFolder } from './runs'
import { getRoomView } from './state'
import { queueFile } from './sync'

// The project root, read once per load: a timer or a tool call later reads
// this instead of asking $.session.root() on every edit.
let root: string | undefined

export async function readRoot($: EngineInterface): Promise<void> {
  root = await $.session.root()
}

// A path inside the project, as the server and other rooms see it
// (forward slashes, relative). Paths outside the project are never sent.
export function projectPath(projectRoot: string, path: string): string | null {
  const slashes = (text: string) => text.replaceAll('\\', '/')
  const base = `${slashes(projectRoot).replace(/\/+$/, '')}/`
  const full = slashes(path)
  const isDrive = /^[a-zA-Z]:\//.test(base)
  const isInside = isDrive ? full.toLowerCase().startsWith(base.toLowerCase()) : full.startsWith(base)
  if (!isInside) return null
  const relative = full.slice(base.length)
  return relative === '' ? null : relative
}

// A run's edit counts against the folder it works in (its worktree, maybe).
async function track($: EngineInterface, path: string, agentId: string | undefined): Promise<void> {
  if (root === undefined || (await getRoomView($)) === null) return
  const relative = projectPath((await runFolder($, agentId)) ?? root, path)
  if (relative !== null) queueFile(relative)
}

// Reports every successful edit or write to the room (spec: File Tracking).
// The sync loop sends the queue, so a tool call never waits on the network.
export function trackEdits(on: On): void {
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await track($, e.file_path, e.agentId)
    return ran
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await track($, e.file_path, e.agentId)
    return ran
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await track($, e.notebook_path, e.agentId)
    return ran
  }).catch(($, e, next) => next(e))
}
