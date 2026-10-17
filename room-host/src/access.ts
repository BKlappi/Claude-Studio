// What a joiner may do in the room's repo (D19), asked of GitHub with the
// host person's own `gh` (D6). Anything unclear is 'unknown', and the host
// person decides by hand: Studio never admits on a guess.

import { execFile } from 'node:child_process'
import { loginKey, roleFor } from '../../plugin/protocol/join.ts'
import type { GithubRepo, RepoPermission } from '../../plugin/protocol/join.ts'
import type { Role } from '../../plugin/protocol/types.ts'

export type RepoAccess =
  | { kind: 'role'; role: Role; permission: RepoPermission }
  | { kind: 'refused'; permission: RepoPermission }
  | { kind: 'unknown'; reason: string }

export type CheckAccess = (repo: GithubRepo, login: string) => Promise<RepoAccess>

export type GhAnswer = { ok: true; json: unknown } | { ok: false; message: string }
export type Gh = (args: string[]) => Promise<GhAnswer>

const TIMEOUT_MS = 10_000
const PERMISSIONS: readonly RepoPermission[] = ['admin', 'maintain', 'write', 'triage', 'read', 'none']

const asPermission = (value: unknown) =>
  PERMISSIONS.find(permission => permission === value) ?? null

// `gh api <path>`: its JSON, or what went wrong in one line.
export function runGh(args: string[]): Promise<GhAnswer> {
  return new Promise(resolve => {
    execFile(
      'gh',
      args,
      { timeout: TIMEOUT_MS, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
      (error, stdout, stderr) => {
        if (error === null) {
          try {
            resolve({ ok: true, json: JSON.parse(stdout) })
          } catch {
            resolve({ ok: false, message: 'gh answered something other than JSON' })
          }
          return
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ ok: false, message: 'gh is not installed on the host' })
          return
        }
        const line = stderr.split(/\r?\n/).find(text => text.trim() !== '')
        resolve({ ok: false, message: (line ?? error.message).trim().slice(0, 200) })
      },
    )
  })
}

// An org owner shows as `admin` on the repo; the org's membership says more.
async function isOwner(gh: Gh, repo: GithubRepo, login: string, permission: RepoPermission): Promise<boolean> {
  if (loginKey(login) === loginKey(repo.owner)) return true
  if (permission !== 'admin') return false
  const membership = await gh(['api', `orgs/${repo.owner}/memberships/${login}`])
  if (!membership.ok) return false
  const { role, state } = membership.json as { role?: unknown; state?: unknown }
  return role === 'admin' && state === 'active'
}

export function ghAccess(gh: Gh = runGh): CheckAccess {
  return async (repo, login) => {
    const name = `${repo.owner}/${repo.name}`
    const answer = await gh(['api', `repos/${name}/collaborators/${login}/permission`])
    if (!answer.ok) return { kind: 'unknown', reason: `GitHub did not say what ${login} may do in ${name} (${answer.message})` }
    const body = answer.json as { permission?: unknown; role_name?: unknown }
    // role_name is finer (maintain, triage); a custom role falls back to permission.
    const permission = asPermission(body.role_name) ?? asPermission(body.permission)
    if (permission === null) return { kind: 'unknown', reason: `GitHub answered an unknown permission for ${login} in ${name}` }
    const role = roleFor({ isOwner: await isOwner(gh, repo, login, permission), permission })
    return role === null ? { kind: 'refused', permission } : { kind: 'role', role, permission }
  }
}
