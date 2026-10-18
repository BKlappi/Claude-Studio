// The review of a finished run (PLAN.md phase 4, protocol/planning.ts): the
// change as git has it, the commands the worker ran as the engine reported
// them (hooks/runs.ts keeps those), and its report, read by the reviewer
// model against the task's spec and checks. Git only reads here, and never
// with a diff driver or text conversion a config could make it run.

import type { EngineInterface } from 'claude-code'
import { parseReply } from '../protocol/coordinator'
import { REVIEWER_INSTRUCTIONS, REVIEW_LIMITS, checkReview, reviewPrompt, reviewSlot } from '../protocol/planning'
import type { ReviewDraft, ReviewInput } from '../protocol/planning'
import { pathIn, runIfThere } from './processes'
import { loadModels } from './state'

const GIT_TIMEOUT_MS = 30_000
const MODEL_TIMEOUT_MS = 180_000
const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']
// A new file larger than this is named, not read.
const MAX_FILE_BYTES = 200_000
const SHA = /^[0-9a-f]{40,64}$/

// No file-system monitor either: a config one names is a program git runs.
function git($: EngineInterface, cwd: string, args: string[]) {
  return runIfThere($, ['git', '-c', 'core.fsmonitor=false', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
}

// Where the review measures a run's change from, taken as it starts: in a
// worktree, the commit the engine starts it at (this checkout's HEAD); in the
// person's own checkout, a snapshot of it as it is, so their own changes are
// not the run's (`git stash create` writes that commit and touches nothing
// else; on a clean checkout it is HEAD). null: git cannot tell.
export async function baseOf($: EngineInterface, root: string, where: 'here' | 'worktree'): Promise<string | null> {
  if (where === 'here') {
    const snapshot = (await git($, root, ['stash', 'create']))?.stdout.trim() ?? ''
    if (SHA.test(snapshot)) return snapshot
  }
  const head = await git($, root, ['rev-parse', '--verify', 'HEAD'])
  const sha = head?.stdout.trim() ?? ''
  return head?.exitCode === 0 && SHA.test(sha) ? sha : null
}

export type Change = Pick<ReviewInput, 'diff' | 'newFiles'>

// What a run changed in `cwd` since `base`: the diff of tracked files, and
// the files it wrote that git does not track (`written`: relative to cwd).
// An error when git cannot show it: then nobody can judge the run.
export async function changeOf($: EngineInterface, cwd: string, base: string, written: readonly string[]): Promise<Change | { error: string }> {
  // The engine removes a worktree its worker left unchanged.
  if (!(await $.fs.exists(cwd))) return { diff: { stat: '', text: '', isCut: false }, newFiles: [] }
  const stat = await git($, cwd, [...DIFF, '--stat', base, '--'])
  const diff = await git($, cwd, [...DIFF, base, '--'])
  if (stat?.exitCode !== 0 || diff?.exitCode !== 0) {
    const why = (diff ?? stat)?.stderr.split(/\r?\n/).find(Boolean) ?? 'git is not there'
    return { error: `git could not show the change (${why.slice(0, 200)})` }
  }
  const untracked = written.length === 0
    ? []
    : ((await git($, cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...written]))?.stdout ?? '').split('\0').filter(Boolean)
  const newFiles: { path: string; text: string; isCut: boolean }[] = []
  for (const path of untracked) {
    if (newFiles.length === REVIEW_LIMITS.newFiles) break
    const full = pathIn(cwd, ...path.split('/'))
    const size = await $.fs.stat(full).then(found => found.size, () => null)
    if (size === null) continue
    const text = size > MAX_FILE_BYTES ? null : await $.fs.read(full).catch(() => null)
    if (text === null || text.includes('\0')) {
      newFiles.push({ path, text: `(${size} bytes, not shown)`, isCut: false })
      continue
    }
    newFiles.push({ path, text: text.slice(0, REVIEW_LIMITS.fileChars), isCut: text.length > REVIEW_LIMITS.fileChars })
  }
  const isCut = diff.isStdoutTruncated || diff.stdout.length > REVIEW_LIMITS.diffChars
  return { diff: { stat: stat.stdout, text: diff.stdout.slice(0, REVIEW_LIMITS.diffChars), isCut }, newFiles: [...newFiles, ...untracked.slice(newFiles.length).map(path => ({ path, text: '(not shown)', isCut: false }))] }
}

// The reviewer's verdict on a run (a model call, no tools), on the slot of the
// work but never below medium. Asked once more when its answer could not be
// read; an error when it gives none.
export async function reviewRun($: EngineInterface, input: ReviewInput): Promise<{ review: ReviewDraft } | { error: string }> {
  const model = (await loadModels($))[reviewSlot(input.slot)]
  const prompt = reviewPrompt(input)
  let why = 'the reviewer gave no verdict'
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await $.model.complete({
      model,
      // The instructions never change: cached across reviews.
      system: [{ text: REVIEWER_INSTRUCTIONS, cache: true }],
      prompt,
      maxTokens: 4096,
      effort: 'medium',
      timeoutMs: MODEL_TIMEOUT_MS,
    })
    if (!result.isAnswered) {
      const detail = result.reason === 'api-error' ? `${result.error}${result.status === null ? '' : `, ${result.status}`}` : result.reason
      return { error: `its model did not answer (${detail})` }
    }
    const checked = checkReview(parseReply(result.text))
    if ('review' in checked) return checked
    why = checked.error
  }
  return { error: why }
}
