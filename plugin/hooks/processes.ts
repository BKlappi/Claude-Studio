import type { EngineInterface, ProcessRunInit, ProcessRunResult, ProcessSpawnRequest } from 'claude-code'
import { toBase64url } from '../protocol/seal'

export const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Work a hook started and did not await: a failure goes to the debug log,
// never unhandled (it may outlive the module, whose calls then fail).
export function inBackground($: EngineInterface, work: Promise<unknown>): void {
  work.catch(error => {
    try {
      $.ui.log(`Studio: ${describe(error)}`, { to: 'debug' })
    } catch {
      // The module is gone.
    }
  })
}

// A host command's result, or null when it is not installed (cannot start).
export async function runIfThere($: EngineInterface, argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult | null> {
  try {
    return await $.process.run(argv, init)
  } catch (error) {
    if (/ENOENT|not found/i.test(describe(error))) return null
    throw error
  }
}

// How a child of $.process.spawn ended. `isStopped`: this module stopped it.
export type ChildEnd = {
  code: number | null
  signal: string | null
  // The end of what it wrote to standard error, or why it could not start.
  stderrTail: string
  isStopped: boolean
  failedToStart: boolean
}

// `end()`: how it ended, once it has; null while it runs.
export type Child = { stop: () => void; ended: Promise<ChildEnd>; end: () => ChildEnd | null }

// A child for longer than one hook (PLAN.md D15): its output is read line by
// line until it ends; the loop is its life, so stop() ends both.
export function spawnChild(
  $: EngineInterface,
  spawn: ProcessSpawnRequest,
  onLine: (line: string, pipe: 'stdout' | 'stderr') => void,
): Child {
  const stream = $.process.spawn(spawn)
  let isStopped = false
  let result: ChildEnd | null = null
  const ended = (async (): Promise<ChildEnd> => {
    const partial = { stdout: '', stderr: '' }
    let stderrTail = ''
    try {
      let step = await stream.next()
      while (!step.done) {
        const { stream: pipe, text } = step.value
        const lines = (partial[pipe] + text).split(/\r?\n/)
        partial[pipe] = lines.pop() ?? ''
        if (pipe === 'stderr') stderrTail = (stderrTail + text).slice(-2000)
        for (const line of lines) onLine(line, pipe)
        step = await stream.next()
      }
      for (const pipe of ['stdout', 'stderr'] as const) if (partial[pipe] !== '') onLine(partial[pipe], pipe)
      return { code: step.value?.code ?? null, signal: step.value?.signal ?? null, stderrTail, isStopped, failedToStart: false }
    } catch (error) {
      return { code: null, signal: null, stderrTail: describe(error), isStopped, failedToStart: true }
    }
  })()
  return {
    stop: () => {
      isStopped = true
      void stream.return({ code: null, signal: null }).catch(() => undefined)
    },
    ended: ended.then(end => (result = end)),
    end: () => result,
  }
}

// What a child said last, for a message: its standard error's last line.
export function lastWords(end: ChildEnd): string {
  const line = end.stderrTail.split(/\r?\n/).map(text => text.trim()).filter(Boolean).at(-1)
  const how = end.failedToStart ? 'could not start' : `exit ${end.code ?? end.signal ?? '?'}`
  return line === undefined ? how : `${how}: ${line.slice(0, 300)}`
}

export class TimeoutError extends Error {}

// `promise`, or a TimeoutError after `ms` on the session's clock.
export function withTimeout<T>($: EngineInterface, promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = $.clock.after(ms, () => reject(new TimeoutError(message)))
    promise.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      error => {
        timer.cancel()
        reject(error)
      },
    )
  })
}

export type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

// The person's home folder, with the separator its paths use.
export async function homeDir($: EngineInterface): Promise<{ path: string; sep: string } | null> {
  const path = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (path === undefined || path === '') return null
  return { path: path.replace(/[\\/]+$/, ''), sep: path.includes('\\') ? '\\' : '/' }
}

// `parts` under `root`, with the separator `root` uses.
export function pathIn(root: string, ...parts: string[]): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return [root.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

// The folder `path` is in: `C:\a\b\` and `/a/b` give `C:\a` and `/a`.
export const parentOf = (path: string) => path.replace(/[\\/]+[^\\/]*[\\/]*$/, '')

export const randomKey = () => toBase64url(crypto.getRandomValues(new Uint8Array(32)))
