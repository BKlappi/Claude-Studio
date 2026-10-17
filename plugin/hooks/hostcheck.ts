// Can this machine host a room? Asked before /room create starts anything
// (PLAN.md D20): Node 24 for the room host, the room host's own files and
// installed dependencies, and a way for other machines to reach it. Every
// problem is named once, with the line that fixes it, instead of surfacing
// later as "room lost: ..." in the provider's own words.

import type { EngineInterface } from 'claude-code'
import { homeDir, parentOf, pathIn, runIfThere } from './processes'
import { hasCloudflared, pickProviders, tailnetName } from './providers'
import type { Provider } from './providers'

const NODE_MAJOR = 24
const RUN_TIMEOUT_MS = 10_000

type Platform = 'windows' | 'macos' | 'linux'

// The mod has no platform call: a home folder with backslashes is Windows,
// /Users/... macOS, anything else Linux. Only the install lines depend on it.
async function platformOf($: EngineInterface): Promise<Platform> {
  const home = await homeDir($)
  if (home === null) return 'linux'
  if (home.sep === '\\') return 'windows'
  return home.path.startsWith('/Users/') ? 'macos' : 'linux'
}

const INSTALL = {
  node: {
    windows: 'winget install OpenJS.NodeJS',
    macos: 'brew install node',
    linux: 'install Node 24 from https://nodejs.org/en/download (or: nvm install 24)',
  },
  cloudflared: {
    windows: 'winget install --id Cloudflare.cloudflared',
    macos: 'brew install cloudflared',
    linux: 'install cloudflared from https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/',
  },
} satisfies Record<string, Record<Platform, string>>

const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download'

// "v24.1.0" -> 24; null when the text is not a Node version.
export function nodeMajor(text: string): number | null {
  const major = /^v?(\d+)\.\d+\.\d+/.exec(text.trim())?.[1]
  return major === undefined ? null : Number(major)
}

export type HostCheck = {
  providers: Provider[]
  // Not a blocker, but the host person should hear it.
  note: string | null
}

// Where the room host lives: beside the plugin, in the same repo.
export function roomHostPaths(pluginRoot: string) {
  const repoDir = parentOf(pluginRoot)
  const roomHostDir = pathIn(repoDir, 'room-host')
  return {
    repoDir,
    roomHostDir,
    roomHostEntry: pathIn(roomHostDir, 'src', 'index.ts'),
    relayEntry: pathIn(roomHostDir, 'src', 'relay.ts'),
  }
}

// Throws one error naming everything that stops this machine from hosting.
export async function checkHost($: EngineInterface, options: { via: Provider | 'auto' }): Promise<HostCheck> {
  const { via } = options
  const { repoDir, roomHostDir, roomHostEntry, relayEntry } = roomHostPaths($.plugin.root)
  const [platform, node, tailnet, cloudflared, hasEntry, hasRelay, hasDeps] = await Promise.all([
    platformOf($),
    runIfThere($, ['node', '--version'], { timeoutMs: RUN_TIMEOUT_MS }).catch(() => null),
    tailnetName($),
    hasCloudflared($),
    $.fs.exists(roomHostEntry),
    $.fs.exists(relayEntry),
    // pnpm links a package's dependencies into its own node_modules; another
    // installer may hoist them to the repo's.
    Promise.all([roomHostDir, repoDir].map(dir => $.fs.exists(pathIn(dir, 'node_modules', 'hono')))).then(found => found.some(Boolean)),
  ])

  const problems: string[] = []

  if (node === null || node.exitCode !== 0) {
    problems.push(`Node.js is not installed, and the room host runs on Node ${NODE_MAJOR} or newer. Install it: ${INSTALL.node[platform]}`)
  } else {
    const major = nodeMajor(node.stdout)
    if (major === null) problems.push(`\`node --version\` said "${node.stdout.trim().slice(0, 40)}", which is not a version`)
    else if (major < NODE_MAJOR) {
      problems.push(`Node ${node.stdout.trim().replace(/^v/, '')} is installed, and the room host needs Node ${NODE_MAJOR} or newer. Install it: ${INSTALL.node[platform]}`)
    }
  }

  if (!hasEntry) {
    problems.push(
      `The room host is not where the plugin expects it (${roomHostEntry}). Studio's repo has to be installed whole, next to plugin/.`,
    )
  } else if (!hasDeps) {
    problems.push(`The room host's dependencies are not installed. Run \`pnpm install\` in ${repoDir}`)
  }
  if (via === 'lan' && hasEntry && !hasRelay) problems.push(`The LAN relay is missing (${relayEntry}).`)

  if ((via === 'tailscale' || via === 'funnel') && tailnet === null) {
    problems.push(`Tailscale is not running on this machine (--via ${via}). Start it, or install it: ${TAILSCALE_DOWNLOAD}`)
  }
  if (via === 'cloudflared' && !cloudflared) {
    problems.push(`cloudflared is not installed (--via cloudflared). Install it: ${INSTALL.cloudflared[platform]}`)
  }

  if (problems.length > 0) {
    throw new Error(`this machine cannot host a room yet:\n${problems.map(problem => `- ${problem}`).join('\n')}`)
  }

  const providers = via === 'auto' ? pickProviders(tailnet, cloudflared) : [via]
  const isLanOnly = via === 'auto' && providers.length === 1
  return {
    providers,
    note: isLanOnly
      ? `Only machines on this network can reach the room: neither Tailscale (running) nor cloudflared was found. For people elsewhere, install cloudflared (${INSTALL.cloudflared[platform]}) and /room create again.`
      : null,
  }
}
