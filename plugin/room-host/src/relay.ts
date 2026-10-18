// The LAN address provider (PLAN.md D16, last resort): relays TCP from this
// machine's LAN address to the room host on 127.0.0.1, so the room host
// itself never listens beyond loopback. No TLS: room keys and session tokens
// cross the LAN in clear, which is why the mod warns before using it.
//
//   node src/relay.ts --to <room host port>
//
// Prints one HostEvent line, { "event": "relay", "address": "http://<ip>:<port>" },
// once it listens; exits when killed.

import { createConnection, createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { parseArgs } from 'node:util'
import type { HostEvent } from '../../protocol/types.ts'

const { values: args } = parseArgs({ options: { to: { type: 'string' }, port: { type: 'string' } }, strict: true })
const target = Number(args.to)
if (!Number.isInteger(target) || target <= 0) throw new Error('--to <room host port> is required')

// The first private IPv4 address (10/8, 172.16/12, 192.168/16): a LAN's.
function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      const [a = 0, b = 0] = address.address.split('.').map(Number)
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return address.address
    }
  }
  return null
}

const host = lanAddress()
if (host === null) throw new Error('no LAN address on this machine')

const server = createServer(socket => {
  const upstream = createConnection({ host: '127.0.0.1', port: target })
  socket.pipe(upstream).pipe(socket)
  socket.on('error', () => upstream.destroy())
  upstream.on('error', () => socket.destroy())
})

server.listen(Number(args.port ?? 0), host, () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('relay has no port')
  const event: HostEvent = { event: 'relay', address: `http://${host}:${address.port}` }
  process.stdout.write(`${JSON.stringify(event)}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0))

// Orphan guard, as the room host's (src/index.ts).
if (process.platform !== 'win32') {
  const parent = process.ppid
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0)
  }, 5000).unref()
}
