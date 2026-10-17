// Who this person is on GitHub, and the SSH key that proves it (PLAN.md D6;
// §9 spike 1 for how the key is picked).
//
//   login   gh api user → git config github.user → asked once (/studio login <login>)
//   key     one github.com/<login>.keys lists and this machine can sign with:
//           held by ssh-agent (ssh-add -L), else a key file without a
//           passphrase (ssh-keygen -y -P ""); else the person runs ssh-add
//
// Windows' ssh-keygen hangs on a key with a passphrase when there is no
// terminal, so every ssh call has a short timeout.

import type { EngineInterface } from 'claude-code'
import { GITHUB_LOGIN, JOIN_NAMESPACE } from '../protocol/join'
import { describe, homeDir, runIfThere } from './processes'
import { saveIdentity } from './state'
import type { Identity } from './state'

const SSH_TIMEOUT_MS = 10_000

// "type base64" of a key line (comment dropped), or null for anything else.
// Security keys (sk-*) are left out: the room host cannot check them.
export function keyOf(line: string): string | null {
  const [type, base64] = line.trim().split(/\s+/)
  if (type === undefined || base64 === undefined || !/^(ssh-|ecdsa-)/.test(type)) return null
  return `${type} ${base64}`
}

const firstLine = (text: string) => text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? ''

// The GitHub login gh is signed in as, or the one git config names.
export async function githubLogin($: EngineInterface): Promise<string | null> {
  const gh = await runIfThere($, ['gh', 'api', 'user', '--jq', '.login'], { timeoutMs: SSH_TIMEOUT_MS }).catch(() => null)
  const fromGh = gh?.exitCode === 0 ? gh.stdout.trim() : ''
  if (GITHUB_LOGIN.test(fromGh)) return fromGh
  const git = await runIfThere($, ['git', 'config', '--get', 'github.user']).catch(() => null)
  const fromGit = git?.exitCode === 0 ? git.stdout.trim() : ''
  return GITHUB_LOGIN.test(fromGit) ? fromGit : null
}

// github.com/<login>.keys: the account's authentication keys; null when
// GitHub has no such account.
export async function githubKeyList($: EngineInterface, login: string): Promise<string[] | null> {
  const response = await $.http.fetch(`https://github.com/${login}.keys`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`github.com answered ${response.status} for ${login}'s keys`)
  return response.text.split(/\r?\n/).map(keyOf).filter((key): key is string => key !== null)
}

type LocalKey = {
  publicKey: string
  // <name>.pub in ~/.ssh, and its private half beside it when there is one.
  pubFile: string | null
  privateFile: string | null
  isInAgent: boolean
}

async function localKeys($: EngineInterface): Promise<LocalKey[]> {
  const keys = new Map<string, LocalKey>()
  const agent = await runIfThere($, ['ssh-add', '-L'], { timeoutMs: SSH_TIMEOUT_MS }).catch(() => null)
  if (agent?.exitCode === 0) {
    for (const line of agent.stdout.split(/\r?\n/)) {
      const key = keyOf(line)
      if (key !== null) keys.set(key, { publicKey: key, pubFile: null, privateFile: null, isInAgent: true })
    }
  }
  const home = await homeDir($)
  if (home === null) return [...keys.values()]
  const dir = `${home.path}${home.sep}.ssh`
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.pub')) continue
    const pubFile = `${dir}${home.sep}${entry.name}`
    const key = keyOf(await $.fs.read(pubFile).catch(() => ''))
    if (key === null) continue
    const privateFile = pubFile.slice(0, -'.pub'.length)
    keys.set(key, {
      publicKey: key,
      pubFile,
      privateFile: (await $.fs.exists(privateFile)) ? privateFile : null,
      isInAgent: keys.get(key)?.isInAgent ?? false,
    })
  }
  return [...keys.values()]
}

type KeyChoice = Pick<Identity, 'keyFile' | 'publicKey' | 'noKey'>

const noKey = (why: string): KeyChoice => ({ keyFile: null, publicKey: null, noKey: why })

// The key to sign joins with: one GitHub lists for the login that this
// machine can use without asking for a passphrase.
async function chooseKey($: EngineInterface, login: string, listed: readonly string[]): Promise<KeyChoice> {
  const onGithub = new Set(listed)
  const mine = (await localKeys($)).filter(key => onGithub.has(key.publicKey))

  const held = mine.find(key => key.isInAgent)
  if (held !== undefined) {
    if (held.pubFile !== null) return { keyFile: held.pubFile, publicKey: held.publicKey }
    // In the agent with no .pub file on disk: ssh-keygen needs one to name it.
    const home = await homeDir($)
    if (home !== null) {
      const file = `${home.path}${home.sep}.claude${home.sep}studio${home.sep}agent-key.pub`
      await $.fs.write(file, `${held.publicKey}\n`)
      return { keyFile: file, publicKey: held.publicKey }
    }
  }
  for (const key of mine) {
    if (key.privateFile === null) continue
    const probe = await runIfThere($, ['ssh-keygen', '-y', '-P', '', '-f', key.privateFile], { timeoutMs: SSH_TIMEOUT_MS }).catch(() => null)
    if (probe?.exitCode === 0) return { keyFile: key.privateFile, publicKey: key.publicKey }
  }

  const locked = mine.find(key => key.privateFile !== null)?.privateFile
  if (locked !== undefined) return noKey(`${locked} has a passphrase: run ssh-add ${locked}, then /studio login again`)
  if (listed.length === 0) return noKey(`github.com/${login}.keys lists no SSH key: add one at https://github.com/settings/keys`)
  return noKey(`none of this machine's SSH keys is one github.com/${login}.keys lists: add yours at https://github.com/settings/keys, or ssh-add it`)
}

// Links the login and picks its key, then keeps both in $.store. A login
// without a usable key is linked too: joins then go to the host person.
export async function linkIdentity($: EngineInterface, given?: string): Promise<Identity> {
  const login = given ?? (await githubLogin($))
  if (login === null) throw new Error('which GitHub login is yours? Run /studio login <your-github-login>')
  if (!GITHUB_LOGIN.test(login)) throw new Error(`not a GitHub login: ${login}`)
  const listed = await githubKeyList($, login)
  if (listed === null) throw new Error(`GitHub has no account ${login}`)
  const identity: Identity = { login, ...(await chooseKey($, login, listed)) }
  await saveIdentity($, identity)
  return identity
}

// `ssh-keygen -Y sign` over the join message (standard input to standard output).
export async function signJoin($: EngineInterface, keyFile: string, message: string): Promise<string> {
  let result
  try {
    result = await $.process.run(['ssh-keygen', '-Y', 'sign', '-n', JOIN_NAMESPACE, '-f', keyFile], {
      stdin: message,
      timeoutMs: SSH_TIMEOUT_MS,
    })
  } catch (error) {
    throw new Error(`ssh-keygen could not sign: ${describe(error)}`)
  }
  if (result.exitCode !== 0 || !result.stdout.includes('BEGIN SSH SIGNATURE')) {
    throw new Error(`ssh-keygen could not sign: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`)
  }
  return result.stdout
}
