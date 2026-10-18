// The room directory (PLAN.md D17): rooms.json on the orphan branch
// `studio-rooms` of the room's repo, so open rooms can be found, and hosts
// found again, without a server. Hosts write it on create, host change and
// close; anyone in the repo reads it.
//
// Git plumbing only: nothing is checked out, the person's working tree,
// index and branches are never touched, and no ref is written locally.
// A write reads the branch's head (ls-remote), builds the new commit on it
// (hash-object, mktree, commit-tree) and pushes that commit; a push that lost
// a race (non-fast-forward) reads again and replays the change on top.
//
// A private room's entry is sealed with its room key (protocol/seal.ts):
// only its id and time are readable without the key.

import type { EngineInterface, ProcessRunInit, ProcessRunResult } from 'claude-code'
import { GITHUB_LOGIN, isOrigin, isRoomId } from '../protocol/join'
import { seal, unseal } from '../protocol/seal'
import type { RoomVisibility } from '../protocol/types'
import { describe } from './processes'

export const BRANCH = 'studio-rooms'
const FILE = 'rooms.json'
const REMOTE = 'origin'
const LOCAL_TIMEOUT_MS = 15_000
const NETWORK_TIMEOUT_MS = 60_000
const MAX_TRIES = 5

// A room as the directory lists it, once readable.
export type Listing = { id: string; name: string; host: string; address: string; visibility: RoomVisibility; updatedAt: number }

export type DirectoryEntry =
  | { id: string; visibility: 'open'; name: string; host: string; address: string; updatedAt: number }
  | { id: string; visibility: 'private'; sealed: string; updatedAt: number }

const isText = (value: unknown, max = 300): value is string => typeof value === 'string' && value.length <= max
const isLogin = (value: unknown): value is string => typeof value === 'string' && GITHUB_LOGIN.test(value)

// Another machine's address: an entry naming the reader's own machine
// (127.x, 0.x, localhost, in any spelling URL accepts) would have /room list
// ask the reader's own services.
function isElsewhere(address: string): boolean {
  try {
    const { hostname } = new URL(address)
    return !(hostname === 'localhost' || hostname.endsWith('.localhost') || /^(?:127|0)\./.test(hostname))
  } catch {
    return false
  }
}

const isAddress = (value: unknown): value is string => isText(value) && isOrigin(value) && isElsewhere(value)

function isEntry(value: unknown): value is DirectoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  if (!isText(entry.id, 64) || !isRoomId(entry.id) || !Number.isFinite(entry.updatedAt)) return false
  if (entry.visibility === 'private') return isText(entry.sealed, 4096)
  return entry.visibility === 'open' && isText(entry.name, 100) && isLogin(entry.host) && isAddress(entry.address)
}

// Anyone with write access to the repo can write this file: whatever does
// not look like an entry is left out.
export function parseDirectory(text: string): DirectoryEntry[] {
  try {
    const parsed = JSON.parse(text) as { rooms?: unknown }
    return Array.isArray(parsed.rooms) ? parsed.rooms.filter(isEntry) : []
  } catch {
    return []
  }
}

export function formatDirectory(entries: readonly DirectoryEntry[]): string {
  const rooms = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return `${JSON.stringify({ version: 1, rooms }, null, 2)}\n`
}

export async function entryOf(listing: Listing, roomKey: string | null): Promise<DirectoryEntry> {
  const { id, name, host, address, visibility, updatedAt } = listing
  if (visibility === 'open') return { id, visibility, name, host, address, updatedAt }
  if (roomKey === null) throw new Error('a private room needs its key to be listed')
  return { id, visibility, sealed: await seal(roomKey, id, JSON.stringify({ name, host, address })), updatedAt }
}

// The entry as a listing; a private one only with its key, and only unchanged.
export async function openEntry(entry: DirectoryEntry, roomKey: string | null): Promise<Listing | null> {
  if (entry.visibility === 'open') return { ...entry }
  if (roomKey === null) return null
  const text = await unseal(roomKey, entry.id, entry.sealed)
  if (text === null) return null
  try {
    const { name, host, address } = JSON.parse(text) as Record<string, unknown>
    if (!isText(name, 100) || !isLogin(host) || !isAddress(address)) return null
    return { id: entry.id, name, host, address, visibility: 'private', updatedAt: entry.updatedAt }
  } catch {
    return null
  }
}

// --- git ------------------------------------------------------------------

class GitError extends Error {}

async function git($: EngineInterface, cwd: string, args: string[], init: ProcessRunInit = {}): Promise<ProcessRunResult> {
  try {
    return await $.process.run(['git', ...args], {
      cwd,
      timeoutMs: LOCAL_TIMEOUT_MS,
      ...init,
      // Never wait for a password prompt nobody sees.
      env: { GIT_TERMINAL_PROMPT: '0', ...init.env },
    })
  } catch (error) {
    throw new GitError(`git ${args[0]}: ${describe(error)}`)
  }
}

// A remote URL can carry a token (https://user:token@host/...): never in a message.
const firstLine = (text: string) =>
  (text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '').replace(/\/\/[^/\s@]+@/g, '//***@')

async function gitOk($: EngineInterface, cwd: string, args: string[], init?: ProcessRunInit): Promise<string> {
  const result = await git($, cwd, args, init)
  if (result.exitCode !== 0) throw new GitError(`git ${args[0]}: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`)
  return result.stdout.trim()
}

// The branch's head on the remote; null while there is no branch.
async function remoteHead($: EngineInterface, cwd: string): Promise<string | null> {
  const result = await git($, cwd, ['ls-remote', '--exit-code', REMOTE, `refs/heads/${BRANCH}`], { timeoutMs: NETWORK_TIMEOUT_MS })
  if (result.exitCode === 2) return null
  if (result.exitCode !== 0) throw new GitError(`git ls-remote: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`)
  const sha = result.stdout.trim().split(/\s+/)[0] ?? ''
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new GitError('git ls-remote: no commit for the branch')
  return sha
}

async function entriesAt($: EngineInterface, cwd: string, head: string): Promise<DirectoryEntry[]> {
  const has = await git($, cwd, ['cat-file', '-e', `${head}^{commit}`])
  if (has.exitCode !== 0) {
    // By its id: no ref is written here, FETCH_HEAD included.
    await gitOk($, cwd, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', REMOTE, head], { timeoutMs: NETWORK_TIMEOUT_MS })
  }
  const file = await git($, cwd, ['show', `${head}:${FILE}`])
  return file.exitCode === 0 ? parseDirectory(file.stdout) : []
}

export async function readDirectory($: EngineInterface, cwd: string): Promise<{ head: string | null; entries: DirectoryEntry[] }> {
  const head = await remoteHead($, cwd)
  return { head, entries: head === null ? [] : await entriesAt($, cwd, head) }
}

const isLostRace = (result: ProcessRunResult) =>
  /\[rejected\]|non-fast-forward|fetch first|stale info|failed to update ref|cannot lock ref/i.test(`${result.stdout}\n${result.stderr}`)

// Applies `change` to the directory and pushes it; replays it on a newer
// head when another host pushed first. False when nothing needed changing.
export async function changeDirectory(
  $: EngineInterface,
  cwd: string,
  change: (entries: DirectoryEntry[]) => DirectoryEntry[] | Promise<DirectoryEntry[]>,
  message: string,
  login: string,
): Promise<boolean> {
  // Commits name the person, under a noreply address.
  const author = `studio (${login})`
  const email = `${login}@users.noreply.github.com`
  const env = { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email }

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const { head, entries } = await readDirectory($, cwd)
    const next = await change(entries)
    const text = formatDirectory(next)
    if (text === formatDirectory(entries) && (head !== null || next.length === 0)) return false

    const blob = await gitOk($, cwd, ['hash-object', '-w', '--stdin'], { stdin: text })
    const tree = await gitOk($, cwd, ['mktree'], { stdin: `100644 blob ${blob}\t${FILE}\n` })
    const commit = await gitOk($, cwd, ['commit-tree', tree, ...(head === null ? [] : ['-p', head]), '-m', message], { env })
    const push = await git($, cwd, ['push', '--quiet', '--porcelain', REMOTE, `${commit}:refs/heads/${BRANCH}`], {
      timeoutMs: NETWORK_TIMEOUT_MS,
    })
    if (push.exitCode === 0) return true
    if (!isLostRace(push)) throw new GitError(`git push: ${firstLine(push.stderr) || firstLine(push.stdout) || `exit ${push.exitCode}`}`)
    // Another host pushed between our read and our push: back off, replay.
    await $.clock.sleep(500 + Math.floor(Math.random() * 1500 * attempt))
  }
  throw new GitError(`the ${BRANCH} branch kept changing: gave up after ${MAX_TRIES} tries`)
}

// The room, in the directory under its id: on create and after an address change.
// `dropIds`: entries of this host's that no longer answer, removed with it.
export async function publishRoom(
  $: EngineInterface,
  cwd: string,
  listing: Listing,
  roomKey: string | null,
  options: { login: string; dropIds?: readonly string[] },
): Promise<boolean> {
  const drop = new Set([listing.id, ...(options.dropIds ?? [])])
  // Sealed once: a replay after a lost race reuses the same entry.
  const entry = await entryOf(listing, roomKey)
  return changeDirectory(
    $,
    cwd,
    entries => [...entries.filter(old => !drop.has(old.id)), entry],
    listing.visibility === 'open' ? `studio: ${listing.host} hosts ${listing.name}` : 'studio: a private room is hosted',
    options.login,
  )
}

// The room's entry out of the directory, if it still names this host at
// `address`: after a handover the entry is the new host's, and stays.
export function unpublishRoom(
  $: EngineInterface,
  cwd: string,
  roomId: string,
  login: string,
  mine: { address: string | null; roomKey: string | null },
): Promise<boolean> {
  return changeDirectory(
    $,
    cwd,
    async entries => {
      const entry = entries.find(candidate => candidate.id === roomId)
      if (entry === undefined) return entries
      const listing = await openEntry(entry, mine.roomKey)
      const isMine = listing !== null && listing.host.toLowerCase() === login.toLowerCase() && (mine.address === null || listing.address === mine.address)
      return isMine ? entries.filter(candidate => candidate.id !== roomId) : entries
    },
    'studio: a room closed',
    login,
  )
}

// The room's entry as the directory lists it now, and what it says (a private
// one only with its key). Both null when the room is not listed.
export async function findRoom(
  $: EngineInterface,
  cwd: string,
  roomId: string,
  roomKey: string | null,
): Promise<{ entry: DirectoryEntry | null; listing: Listing | null }> {
  const { entries } = await readDirectory($, cwd)
  const entry = entries.find(candidate => candidate.id === roomId) ?? null
  return { entry, listing: entry === null ? null : await openEntry(entry, roomKey) }
}

// Lists the room at `listing.address` only while its entry is still the one
// read before (`expected`; null: none). Candidates taking over from a host
// that vanished (PLAN.md §5) race through here: the first push wins, and a
// later one finds the entry changed and takes nothing.
export async function claimRoom(
  $: EngineInterface,
  cwd: string,
  listing: Listing,
  roomKey: string | null,
  options: { login: string; expected: DirectoryEntry | null },
): Promise<'won' | 'taken'> {
  const entry = await entryOf(listing, roomKey)
  const before = JSON.stringify(options.expected)
  let isTaken = false
  await changeDirectory(
    $,
    cwd,
    entries => {
      const current = entries.find(candidate => candidate.id === listing.id) ?? null
      isTaken = JSON.stringify(current) !== before
      return isTaken ? entries : [...entries.filter(candidate => candidate.id !== listing.id), entry]
    },
    listing.visibility === 'open' ? `studio: ${listing.host} takes over ${listing.name}` : 'studio: a private room has a new host',
    options.login,
  )
  return isTaken ? 'taken' : 'won'
}
