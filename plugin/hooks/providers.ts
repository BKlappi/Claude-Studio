// Address providers (PLAN.md D16): what makes a room host on 127.0.0.1
// reachable from other machines. Each runs as a child of this session
// (PLAN.md D15) and answers with the address joiners dial.
//
//   tailscale    `tailscale serve --http=<port>` in the foreground: tailnet only
//   funnel       `tailscale funnel --https=443`: public, when asked for
//   cloudflared  a quick tunnel: public HTTPS, a new random name per start
//   lan          room-host/src/relay.ts on this machine's LAN address: no TLS
//
// A provider counts as up once a request through its address reaches the
// room host's /health from here. A quick tunnel's name is waited for in DNS
// over HTTPS first, before anything looks it up through the system's
// resolver: a name looked up too early stays "not found" in that cache for a
// minute (PLAN.md §9, spike 2).

import type { EngineInterface } from 'claude-code'
import type { HostEvent } from '../protocol/types'
import { request } from './api'
import { deferred, describe, lastWords, runIfThere, spawnChild, withTimeout } from './processes'
import type { Child } from './processes'

export type Provider = 'tailscale' | 'funnel' | 'cloudflared' | 'lan'
export const PROVIDERS: readonly Provider[] = ['tailscale', 'funnel', 'cloudflared', 'lan']

export type Exposure = { provider: Provider; address: string; child: Child; warning: string | null }

export const WARNINGS: Record<Provider, string | null> = {
  tailscale: 'tailnet only: people outside your tailnet cannot reach it (/room create --via cloudflared or --via funnel)',
  funnel: null,
  cloudflared: null,
  lan: 'LAN only, no TLS: joiners must be on this network, and room keys and tokens cross it in clear',
}

const RUN_TIMEOUT_MS = 10_000
const ADDRESS_WAIT_MS = 30_000
const DNS_WAIT_MS = 90_000
const DNS_EVERY_MS = 2_000
const HEALTH_WAIT_MS = 30_000
const HEALTH_EVERY_MS = 2_000

// The machine's tailnet name while Tailscale runs, else null.
export async function tailnetName($: EngineInterface): Promise<string | null> {
  const status = await runIfThere($, ['tailscale', 'status', '--json'], { timeoutMs: RUN_TIMEOUT_MS }).catch(() => null)
  if (status?.exitCode !== 0) return null
  try {
    const parsed = JSON.parse(status.stdout) as { BackendState?: unknown; Self?: { DNSName?: unknown } }
    const name = typeof parsed.Self?.DNSName === 'string' ? parsed.Self.DNSName.replace(/\.$/, '').toLowerCase() : ''
    return parsed.BackendState === 'Running' && name !== '' ? name : null
  } catch {
    return null
  }
}

export async function hasCloudflared($: EngineInterface): Promise<boolean> {
  const version = await runIfThere($, ['cloudflared', '--version'], { timeoutMs: RUN_TIMEOUT_MS }).catch(() => null)
  return version?.exitCode === 0
}

// The providers a machine has, in the order D16 picks them; funnel only when
// asked for by name.
export function pickProviders(tailnet: string | null, cloudflared: boolean): Provider[] {
  return [...(tailnet === null ? [] : ['tailscale' as const]), ...(cloudflared ? ['cloudflared' as const] : []), 'lan']
}

// Whether public DNS has an address for `host` yet (Cloudflare's DNS over
// HTTPS, which no resolver of this machine caches).
export async function isInDns($: EngineInterface, host: string): Promise<boolean> {
  const response = await $.http.fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
    headers: { accept: 'application/dns-json' },
  })
  if (!response.ok) return false
  const answer = JSON.parse(response.text) as { Status?: unknown; Answer?: unknown[] }
  return answer.Status === 0 && (answer.Answer?.length ?? 0) > 0
}

async function waitForDns($: EngineInterface, host: string, child: Child): Promise<void> {
  const until = (await $.clock.now()) + DNS_WAIT_MS
  for (;;) {
    if (await isInDns($, host).catch(() => false)) return
    if (child.end() !== null) throw new Error('the tunnel stopped while its name was not in DNS yet')
    if ((await $.clock.now()) >= until) throw new Error(`${host} was not in DNS after ${DNS_WAIT_MS / 1000} s`)
    await $.clock.sleep(DNS_EVERY_MS)
  }
}

// The room host answers through `address`; false once the wait is over.
export async function answersAt($: EngineInterface, address: string, child: Child | null, waitMs = HEALTH_WAIT_MS): Promise<boolean> {
  const until = (await $.clock.now()) + waitMs
  for (;;) {
    try {
      await request($, address, 'GET', '/health')
      return true
    } catch {
      if (child !== null && child.end() !== null) return false
      if ((await $.clock.now()) >= until) return false
      await $.clock.sleep(HEALTH_EVERY_MS)
    }
  }
}

// Starts a provider's child and resolves with the first thing `pick` finds
// in its output, or rejects once the child ends or the wait is over.
async function startChild(
  $: EngineInterface,
  argv: string[],
  pick: (line: string) => string | null,
  what: string,
): Promise<{ child: Child; found: string }> {
  const found = deferred<string>()
  let lastLine = ''
  const child = spawnChild($, { argv }, line => {
    if (line.trim() !== '') lastLine = line.trim()
    const value = pick(line)
    if (value !== null) found.resolve(value)
  })
  const first = await withTimeout(
    $,
    Promise.race([found.promise.then(value => ({ value })), child.ended.then(end => ({ end }))]),
    ADDRESS_WAIT_MS,
    `${what} said nothing usable within ${ADDRESS_WAIT_MS / 1000} s${lastLine === '' ? '' : ` (last: ${lastLine.slice(0, 200)})`}`,
  ).catch(error => {
    child.stop()
    throw error
  })
  if ('end' in first) throw new Error(`${what} stopped (${lastLine === '' ? lastWords(first.end) : lastLine.slice(0, 300)})`)
  return { child, found: first.value }
}

async function exposeCloudflared($: EngineInterface, port: number): Promise<Exposure> {
  const registered = deferred<void>()
  const { child, found: address } = await startChild(
    $,
    ['cloudflared', 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
    line => {
      if (/Registered tunnel connection/i.test(line)) registered.resolve()
      return /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0] ?? null
    },
    'cloudflared',
  )
  try {
    const first = await withTimeout(
      $,
      Promise.race([registered.promise.then(() => true), child.ended.then(() => false)]),
      ADDRESS_WAIT_MS,
      'cloudflared did not register its tunnel within 30 s',
    )
    if (!first) throw new Error('cloudflared stopped before its tunnel was registered')
    await waitForDns($, new URL(address).hostname, child)
    if (!(await answersAt($, address, child))) throw new Error(`the room host does not answer at ${address}`)
  } catch (error) {
    child.stop()
    throw error
  }
  return { provider: 'cloudflared', address, child, warning: WARNINGS.cloudflared }
}

async function exposeTailscale($: EngineInterface, port: number, isFunnel: boolean): Promise<Exposure> {
  const name = await tailnetName($)
  if (name === null) throw new Error('Tailscale is not running on this machine')
  const target = `http://127.0.0.1:${port}`
  // In the foreground, so the serve config goes when the child does.
  const argv = isFunnel ? ['tailscale', 'funnel', '--https=443', target] : ['tailscale', 'serve', `--http=${port}`, target]
  const address = isFunnel ? `https://${name}` : `http://${name}:${port}`
  let lastLine = ''
  const child = spawnChild($, { argv }, line => {
    if (line.trim() !== '') lastLine = line.trim()
  })
  if (!(await answersAt($, address, child))) {
    child.stop()
    const end = child.end()
    const why = lastLine !== '' ? lastLine.slice(0, 300) : end === null ? 'no answer' : lastWords(end)
    throw new Error(`tailscale ${isFunnel ? 'funnel' : 'serve'} did not make ${address} answer (${why})`)
  }
  const provider = isFunnel ? 'funnel' : 'tailscale'
  return { provider, address, child, warning: WARNINGS[provider] }
}

function relayEvent(line: string): string | null {
  try {
    const event = JSON.parse(line) as HostEvent
    return event.event === 'relay' ? event.address : null
  } catch {
    return null
  }
}

async function exposeLan($: EngineInterface, port: number, relayEntry: string): Promise<Exposure> {
  const { child, found: address } = await startChild($, ['node', relayEntry, '--to', String(port)], relayEvent, 'the LAN relay')
  if (!(await answersAt($, address, child, 5_000))) {
    child.stop()
    throw new Error(`the room host does not answer at ${address}`)
  }
  return { provider: 'lan', address, child, warning: WARNINGS.lan }
}

export async function expose($: EngineInterface, provider: Provider, port: number, relayEntry: string): Promise<Exposure> {
  try {
    if (provider === 'cloudflared') return await exposeCloudflared($, port)
    if (provider === 'lan') return await exposeLan($, port, relayEntry)
    return await exposeTailscale($, port, provider === 'funnel')
  } catch (error) {
    throw new Error(`${provider}: ${describe(error)}`)
  }
}
