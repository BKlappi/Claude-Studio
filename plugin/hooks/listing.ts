// /room list (PLAN.md D17): the rooms on the repo's directory branch, merged
// with the room this session is in, each with its host and whether its
// address answers.
//
// The branch is writable by anyone with push access, so what it holds is text
// to show, never to act on: entries are checked as they are read (a room id, a
// GitHub login, an address off this machine: hooks/directory.ts), names are
// reduced to one plain line and quoted (the model reads this reply too), and
// the only request made to an address is GET /health, whose answer is not read.

import type { EngineInterface } from 'claude-code'
import { inviteLink } from '../protocol/join'
import { request } from './api'
import { openEntry, readDirectory } from './directory'
import type { Listing } from './directory'
import { describe, withTimeout } from './processes'
import { getRoomView, loadSaved } from './state'

const HEALTH_WAIT_MS = 5_000
// A directory that grew past this shows its newest rooms and says so.
const MAX_ROWS = 25

// One line of plain text: control, formatting and unassigned characters
// (newlines, bidi overrides, zero-width, lone surrogates) become spaces.
export const plain = (text: string, max: number) => text.replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, max)

// A room name in quotes: whatever it says reads as one name.
const quoted = (name: string) => JSON.stringify(plain(name, 100))

export function ageText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} days ago`
}

type Row = {
  name: string
  host: string
  // What follows the host: "you are here", "reachable", "not answering".
  state: string
  age: string | null
  // The link that joins an open room that answers.
  link: string | null
}

// Whether a room host answers at `address`, within 5 s.
export async function answers($: EngineInterface, address: string): Promise<boolean> {
  try {
    await withTimeout($, request($, address, 'GET', '/health'), HEALTH_WAIT_MS, 'no answer')
    return true
  } catch {
    return false
  }
}

const pad = (text: string, width: number) => text.padEnd(width)

export async function listRooms($: EngineInterface): Promise<string> {
  const saved = await loadSaved($)
  const view = await getRoomView($)
  const now = await $.clock.now()

  let listings: Listing[] = []
  let problem: string | null = null
  try {
    const { entries } = await readDirectory($, await $.session.root())
    // Private entries open only for the room key this session holds (its own room's).
    const opened = await Promise.all(entries.map(entry => openEntry(entry, entry.id === saved?.roomId ? (saved.roomKey ?? null) : null)))
    // One entry per id, the newest.
    const byId = new Map<string, Listing>()
    for (const listing of opened) {
      const old = listing === null ? undefined : byId.get(listing.id)
      if (listing !== null && (old === undefined || old.updatedAt < listing.updatedAt)) byId.set(listing.id, listing)
    }
    listings = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  } catch (error) {
    problem = `The room directory is the studio-rooms branch of this project's origin remote, and it could not be read (${plain(describe(error), 300)}).`
  }

  const rows: Row[] = []
  if (saved !== null) {
    const listed = listings.find(listing => listing.id === saved.roomId)
    rows.push({
      name: quoted(view?.room.name ?? listed?.name ?? saved.roomId),
      host: plain(view?.room.hostLogin ?? listed?.host ?? '?', 39),
      state: 'you are here',
      age: null,
      link: null,
    })
  }
  const others = listings.filter(listing => listing.id !== saved?.roomId)
  const shown = others.slice(0, MAX_ROWS)
  const isUp = await Promise.all(shown.map(listing => answers($, listing.address)))
  shown.forEach((listing, at) => {
    const up = isUp[at] === true
    rows.push({
      name: quoted(listing.name),
      host: plain(listing.host, 39),
      state: up ? 'reachable' : 'not answering',
      age: ageText(now - listing.updatedAt),
      // Private rooms are listed only for the one this session is in, so every row here is open.
      link: up && listing.visibility === 'open' ? inviteLink({ roomId: listing.id, address: listing.address, roomKey: null }) : null,
    })
  })

  if (rows.length === 0) {
    return [problem ?? 'No open rooms are listed.', 'Start one: /room create "<name>"'].join('\n')
  }

  const nameWidth = Math.max(...rows.map(row => row.name.length))
  const hostWidth = Math.max(...rows.map(row => row.host.length))
  const lines = rows.flatMap(row => [
    `${row.state === 'you are here' ? '*' : ' '} ${pad(row.name, nameWidth)}  ${pad(row.host, hostWidth)}  ${row.state}${row.age === null ? '' : ` · ${row.age}`}`,
    ...(row.link === null ? [] : [`    /room join ${row.link}`]),
  ])
  return [
    problem ?? 'Rooms listed on this project\'s studio-rooms branch, each name as its host wrote it:',
    ...(problem === null ? [] : ['']),
    ...lines,
    ...(others.length > shown.length ? [`(${others.length - shown.length} older rooms not shown)`] : []),
  ].join('\n')
}
