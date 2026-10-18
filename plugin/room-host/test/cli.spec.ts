// The room host as the host's mod runs it: a child process, JSON event lines
// on stdout (PLAN.md D15).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CreateRoomResponse, HostEvent } from '../../protocol/types.ts'

const ENTRY = new URL('../src/index.ts', import.meta.url)
const RELAY = new URL('../src/relay.ts', import.meta.url)
const pathOf = (url: URL) => url.pathname.replace(/^\/([A-Za-z]:)/, '$1')

type Host = {
  child: ChildProcess
  next: () => Promise<HostEvent>
  exited: Promise<number | null>
}

function start(args: string[], options: { entry?: URL; env?: Record<string, string> } = {}): Host {
  // stdin closed from the start, as $.process.spawn leaves it.
  const child = spawn(process.execPath, [pathOf(options.entry ?? ENTRY), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
  })
  const events: HostEvent[] = []
  const waiting: ((event: HostEvent) => void)[] = []
  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (text: string) => {
    buffer += text
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const event = JSON.parse(buffer.slice(0, end)) as HostEvent
      buffer = buffer.slice(end + 1)
      const resolve = waiting.shift()
      if (resolve) resolve(event)
      else events.push(event)
    }
  })
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  const next = () => {
    const event = events.shift()
    if (event) return Promise.resolve(event)
    return new Promise<HostEvent>((resolve, reject) => {
      waiting.push(resolve)
      void exited.then(code => reject(new Error(`room host exited (${code}) before the next event`)))
    })
  }
  return { child, next, exited }
}

async function ready(host: Host) {
  const event = await host.next()
  assert.equal(event.event, 'ready')
  if (event.event !== 'ready') throw new Error('unreachable')
  assert.ok(event.port > 0)
  assert.ok(event.hostKey.length >= 32)
  return { base: `http://127.0.0.1:${event.port}`, hostKey: event.hostKey }
}

const send = (url: string, token: string, method = 'POST', body?: unknown) =>
  fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

test('spawned: ready line, then exits and deletes its data when its last room closes', { timeout: 20000 }, async () => {
  const data = join(mkdtempSync(join(tmpdir(), 'studio-host-')), 'room')
  const host = start(['--port', '0', '--data', data])
  try {
    const { base, hostKey } = await ready(host)
    assert.ok(existsSync(join(data, 'room.db')))

    const created = await send(`${base}/host/rooms`, hostKey, 'POST', { name: 'cli', login: 'ben', role: 'owner' })
    assert.equal(created.status, 201)
    const { room, token } = (await created.json()) as CreateRoomResponse

    assert.equal((await send(`${base}/v1/rooms/${room.id}/leave`, token)).status, 200)
    assert.deepEqual(await host.next(), { event: 'room-closed', roomId: room.id })
    assert.deepEqual(await host.next(), { event: 'exiting' })
    assert.equal(await host.exited, 0)
    assert.equal(existsSync(data), false)
  } finally {
    host.child.kill()
    rmSync(join(data, '..'), { recursive: true, force: true })
  }
})

test('spawned: POST /host/close exits; only the host key may ask', { timeout: 20000 }, async () => {
  const host = start(['--port', '0'])
  try {
    const { base, hostKey } = await ready(host)
    assert.equal((await send(`${base}/host/close`, 'wrong')).status, 401)
    assert.equal((await send(`${base}/host/close`, hostKey)).status, 200)
    assert.deepEqual(await host.next(), { event: 'exiting' })
    assert.equal(await host.exited, 0)
  } finally {
    host.child.kill()
  }
})

test('an unknown flag stops it before it listens', { timeout: 20000 }, async () => {
  const host = start(['--port', '0', '--repo', 'x'])
  assert.notEqual(await host.exited, 0)
})

test('spawned again on its port, data and host key, it carries on with its rooms', { timeout: 20000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'studio-host-'))
  const data = join(parent, 'room')
  // A dead room host's folder beside it, and a folder that is no room host's.
  mkdirSync(join(parent, 'dead'))
  writeFileSync(join(parent, 'dead', 'studio-room-host.json'), JSON.stringify({ pid: 2 ** 31 - 2 }))
  mkdirSync(join(parent, 'other'))
  const first = start(['--port', '0', '--data', data])
  let second: Host | undefined
  try {
    const { base, hostKey } = await ready(first)
    assert.equal(existsSync(join(parent, 'dead')), false)
    assert.equal(existsSync(join(parent, 'other')), true)
    const created = await send(`${base}/host/rooms`, hostKey, 'POST', { name: 'carry on', login: 'ben', role: 'owner' })
    const { room, token } = (await created.json()) as CreateRoomResponse

    // Killed without a word, as Windows ends a child.
    first.child.kill('SIGKILL')
    await first.exited
    second = start(['--port', base.split(':').at(-1) ?? '0', '--data', data], { env: { STUDIO_HOST_KEY: hostKey } })
    const again = await ready(second)
    assert.deepEqual(again, { base, hostKey })
    assert.equal((await send(`${base}/v1/rooms/${room.id}/snapshot`, token, 'GET')).status, 200)
  } finally {
    for (const host of [first, second]) {
      host?.child.kill()
      await host?.exited
    }
    rmSync(parent, { recursive: true, force: true })
  }
})

test('the LAN relay says where it listens and carries requests through', { timeout: 20000 }, async t => {
  const host = start(['--port', '0'])
  const relay = { current: undefined as Host | undefined }
  try {
    const { base } = await ready(host)
    relay.current = start(['--to', base.split(':').at(-1) ?? '0'], { entry: RELAY })
    const event = await relay.current.next().catch(() => null)
    if (event === null) {
      t.skip('no LAN address on this machine')
      return
    }
    assert.equal(event.event, 'relay')
    if (event.event !== 'relay') return
    assert.match(event.address, /^http:\/\/(10|172|192)\.[0-9.]+:\d+$/)
    assert.equal((await fetch(`${event.address}/health`)).status, 200)
  } finally {
    host.child.kill()
    relay.current?.child.kill()
  }
})
