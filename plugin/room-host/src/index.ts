import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { serve } from '@hono/node-server'
import type { HostEvent } from '../../protocol/types.ts'
import { createApp } from './app.ts'
import { openDb } from './db/index.ts'
import { openRoomCount } from './rooms.ts'
import { randomToken } from './util.ts'

// Two ways to start:
//   pnpm dev                                a person runs it: 127.0.0.1:8787,
//                                           data/room.db kept, host key printed
//   node src/index.ts --port 0 [--data D]   the host's mod runs it (PLAN.md D15):
//                                           one JSON line per HostEvent on stdout;
//                                           exits once its last room closes, and
//                                           deletes its data. Given the port and
//                                           data folder of one that died (and its
//                                           host key in STUDIO_HOST_KEY), it carries
//                                           on with its rooms: the mod's one restart
// Either way it listens on 127.0.0.1 only: an address provider exposes it.
const { values: args } = parseArgs({
  options: { port: { type: 'string' }, data: { type: 'string' } },
  strict: true,
})
const isSpawned = args.port !== undefined

const DB_FILE = 'room.db'
// Marks a data folder as a spawned room host's: { pid }. Only folders with it
// are ever swept.
const OWNER_FILE = 'studio-room-host.json'
const port = Number(args.port ?? process.env.PORT ?? 8787)
const dataDir = args.data ?? (isSpawned ? null : 'data')
const dbPath = dataDir === null ? ':memory:' : join(dataDir, DB_FILE)
// STUDIO_HOST_KEY keeps one key across `node --watch` restarts while developing.
const hostKey = process.env.STUDIO_HOST_KEY ?? randomToken()

const emit = (event: HostEvent) => {
  if (isSpawned) process.stdout.write(`${JSON.stringify(event)}\n`)
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// A room host that was killed (Windows ends children without a signal) leaves
// its data behind: the next one spawned beside it deletes it.
function sweepSiblings(dir: string): void {
  const parent = dirname(dir)
  for (const name of readdirSync(parent)) {
    const sibling = join(parent, name)
    if (name === basename(dir) || !existsSync(join(sibling, OWNER_FILE))) continue
    try {
      const { pid } = JSON.parse(readFileSync(join(sibling, OWNER_FILE), 'utf8')) as { pid?: unknown }
      if (typeof pid === 'number' && isAlive(pid)) continue
    } catch {
      // Unreadable: written by a host that died mid-write.
    }
    rmSync(sibling, { recursive: true, force: true })
  }
}

if (dataDir !== null) {
  // The room log is private to the host person.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  if (isSpawned) {
    writeFileSync(join(dataDir, OWNER_FILE), JSON.stringify({ pid: process.pid }), { mode: 0o600 })
    sweepSiblings(dataDir)
  }
}
const db = openDb(dbPath)
let listeningPort: number | null = null

const app = createApp({
  db,
  hostKey,
  onRoomClosed: roomId => {
    emit({ event: 'room-closed', roomId })
    if (isSpawned && openRoomCount(db) === 0) shutdown()
  },
  onClose: () => shutdown(),
  localOrigins: () => (listeningPort === null ? [] : [`http://127.0.0.1:${listeningPort}`, `http://localhost:${listeningPort}`]),
})

const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, info => {
  listeningPort = info.port
  if (isSpawned) emit({ event: 'ready', port: info.port, hostKey })
  else console.log(`room host on http://127.0.0.1:${info.port} (db: ${dbPath})\nhost key: ${hostKey}`)
})

function deleteData(dir: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dir, `${DB_FILE}${suffix}`), { force: true })
  rmSync(join(dir, OWNER_FILE), { force: true })
  try {
    rmdirSync(dir)
  } catch {
    // Not empty: something else lives there too, so the folder stays.
  }
}

let isExiting = false

function shutdown(): void {
  if (isExiting) return
  isExiting = true
  emit({ event: 'exiting' })
  // Lets the answer that led here reach its caller first.
  setTimeout(() => {
    server.close()
    db.close()
    if (isSpawned && dataDir !== null) deleteData(dataDir)
    process.exit(0)
  }, 100)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Orphan guard: on macOS and Linux a child whose parent died is re-parented,
// so its parent id changes. On Windows Claude Code ends the child itself, even
// when it is killed (PLAN.md §9, spike 2).
if (isSpawned && process.platform !== 'win32') {
  const parent = process.ppid
  setInterval(() => {
    if (process.ppid !== parent) shutdown()
  }, 5000).unref()
}
