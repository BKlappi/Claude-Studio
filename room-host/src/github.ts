// The public SSH keys a GitHub account lists: its authentication keys
// (github.com/<login>.keys, plain text, one `type base64` per line) and, best
// effort, its signing keys (REST API: 60 requests an hour without a token).

import { GITHUB_LOGIN } from '../../plugin/protocol/join.ts'

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

const TIMEOUT_MS = 5000

// The account's keys, or null when GitHub has no such account.
export async function githubKeys(login: string, fetchImpl: Fetch = fetch): Promise<string[] | null> {
  if (!GITHUB_LOGIN.test(login)) return null

  const listed = await fetchImpl(`https://github.com/${login}.keys`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (listed.status === 404) return null
  if (!listed.ok) throw new Error(`github.com answered ${listed.status} for ${login}'s keys`)
  const keys = (await listed.text()).split('\n').map(line => line.trim()).filter(Boolean)

  try {
    const signing = await fetchImpl(`https://api.github.com/users/${login}/ssh_signing_keys`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'studio-room-host' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (signing.ok) {
      for (const { key } of (await signing.json()) as { key: string }[]) keys.push(key.trim())
    }
  } catch {
    // Rate-limited or offline: the authentication keys still decide.
  }
  return [...new Set(keys)]
}
