import type { EngineInterface } from 'claude-code'
import { parseInvite } from '../protocol/join'
import type { ModelSlot } from '../protocol/types'
import { StudioError, client, isOutOfRoom } from './api'
import { attachRoomHost, createRoom, hostedInvite, isHosting } from './hosting'
import { linkIdentity } from './identity'
import { inviteText } from './invite'
import { cancelJoining, joinRoom } from './joining'
import { listRooms } from './listing'
import { PROVIDERS } from './providers'
import type { Provider } from './providers'
import { getAccount, getJoining, getRoomView, getSync, loadSaved } from './state'
import { forgetRoom, refresh } from './sync'

export const PANE_ID = 'studio-room'

type Reply = { text: string }

const HELP_STUDIO = [
  '/studio status               who you are, your room, sync state',
  '/studio models [hard=<id>] [medium=<id>] [easy=<id>]',
  '/studio login [<github-login>]  link your GitHub login and the SSH key that proves it',
].join('\n')

const HELP_ROOM = [
  '/room create "<name>" [--private] [--via tailscale|funnel|cloudflared|lan]',
  '/room join <invite link>',
  '/room invite                 the link that lets someone in',
  '/room leave',
  '/room open                   show the room pane',
  '/room say <message>          post to the room log (v0, until room mode lands)',
  '/room task "<title>" [spec]  add a task to the map (v0, until the coordinator lands)',
  '/room list                   open rooms in this repo, and whether they answer',
  '/room attach [<url>] [<host key>] [--room <name>]   development: use a room host started by hand',
  '/room send                   (phase 6)',
].join('\n')

// Splits `create "design frontend" --private` into its words, quotes kept together.
export function tokenize(args: string): string[] {
  const words: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let match = pattern.exec(args); match !== null; match = pattern.exec(args)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return words
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function inRoom($: EngineInterface) {
  const saved = await loadSaved($)
  if (saved === null) throw new StudioError(400, 'not in a room')
  return { saved, api: client($, saved) }
}

// --- /studio ------------------------------------------------------------

async function status($: EngineInterface): Promise<Reply> {
  const saved = await loadSaved($)
  if (saved === null) return { text: 'Not in a room.' }
  const who = await getAccount($)
  const view = await getRoomView($)
  const state = await getSync($)
  return {
    text: [
      `you:    ${saved.login}${who === null ? '' : ` · ${who.role}`}`,
      `room:   ${view?.room.name ?? saved.roomId} · hosted by ${view?.room.hostLogin ?? '?'} at ${saved.hostUrl}`,
      `sync:   ${state.error ?? (state.lastOkAt === null ? 'idle' : 'ok')}`,
      ...(view === null ? [] : ['', view.statusText]),
    ].join('\n'),
  }
}

const DEFAULT_MODELS: Record<ModelSlot, string> = {
  hard: 'claude-opus-5-5',
  medium: 'claude-sonnet-5-5',
  easy: 'claude-haiku-5-5',
}

async function models($: EngineInterface, words: string[]): Promise<Reply> {
  const slots = { ...DEFAULT_MODELS, ...((await $.store.get('models')) as Partial<Record<ModelSlot, string>> | undefined) }
  for (const word of words) {
    const [slot, id] = word.split('=')
    if ((slot === 'hard' || slot === 'medium' || slot === 'easy') && id !== undefined && id !== '') slots[slot] = id
    else return { text: `Not a slot assignment: ${word}\nUse hard=<id> medium=<id> easy=<id>.` }
  }
  if (words.length > 0) await $.store.set('models', slots)
  // PLAN.md phase 4: check once that the account can use each model, and warn.
  return { text: `hard:   ${slots.hard}\nmedium: ${slots.medium}\neasy:   ${slots.easy}` }
}

async function login($: EngineInterface, given?: string): Promise<Reply> {
  const identity = await linkIdentity($, given)
  if (identity.keyFile === null) {
    return { text: `Linked ${identity.login}, without a key: ${identity.noKey ?? 'none found'}.\nJoins then wait for the host person to let you in by hand.` }
  }
  return { text: `Linked ${identity.login}: joins are signed with ${identity.keyFile}, a key github.com/${identity.login}.keys lists.` }
}

// /room create "<name>" [--private] [--via <provider>]
async function create($: EngineInterface, words: string[]): Promise<Reply> {
  let name: string | undefined
  let isPrivate = false
  let via: Provider | 'auto' = 'auto'
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''
    if (word === '--private') isPrivate = true
    else if (word === '--via' || word.startsWith('--via=')) {
      const value = word === '--via' ? words[++i] : word.slice('--via='.length)
      const provider = PROVIDERS.find(known => known === value)
      if (provider === undefined) return { text: `--via takes one of: ${PROVIDERS.join(', ')}` }
      via = provider
    } else if (name === undefined && !word.startsWith('--')) name = word
    else return { text: `Not understood: ${word}\n${HELP_ROOM}` }
  }
  if (name === undefined) return { text: 'Usage: /room create "<name>" [--private] [--via tailscale|funnel|cloudflared|lan]' }
  return { text: await createRoom($, { name, visibility: isPrivate ? 'private' : 'open', via }) }
}

// The room host `pnpm dev` starts, unless told otherwise.
const DEV_URL = 'http://127.0.0.1:8787'

// /room attach [<url>] [<host key>] [--room <name>]: the host key may instead
// be STUDIO_HOST_KEY in the environment Claude Code started from, which keeps
// it out of the transcript.
async function attach($: EngineInterface, words: string[]): Promise<Reply> {
  let url = DEV_URL
  let hostKey: string | undefined
  let room: string | undefined
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''
    if (word === '--room' || word.startsWith('--room=')) {
      room = word === '--room' ? words[++i] : word.slice('--room='.length)
      if (room === undefined || room === '') return { text: '--room takes a room name' }
    } else if (/^https?:\/\//i.test(word)) url = word
    else if (hostKey === undefined && !word.startsWith('--')) hostKey = word
    else return { text: `Not understood: ${word}\n${HELP_ROOM}` }
  }
  hostKey ??= (await $.env.get('STUDIO_HOST_KEY')) || undefined
  if (hostKey === undefined) {
    return { text: 'The host key is missing: /room attach <url> <host key>, or set STUDIO_HOST_KEY where Claude Code starts. The room host prints its key when it starts.' }
  }
  return { text: await attachRoomHost($, { url, hostKey, room }) }
}

async function join($: EngineInterface, args: string): Promise<Reply> {
  const invite = parseInvite(args)
  if (invite === null) return { text: 'Usage: /room join studio:join?room=<id>&at=<address> (the link from /room invite)' }
  if ((await loadSaved($)) !== null) return { text: 'You are in a room: /room leave first.' }
  return { text: await joinRoom($, invite) }
}

async function invite($: EngineInterface): Promise<Reply> {
  const saved = await loadSaved($)
  if (saved === null) return { text: 'Not in a room.' }
  const hosted = isHosting() ? hostedInvite() : null
  if (isHosting() && hosted === null) return { text: 'The room is not reachable from other machines yet: the pane shows how far it got.' }
  const text = await inviteText($, hosted ?? { roomId: saved.roomId, address: saved.hostUrl, roomKey: saved.roomKey ?? null })
  if (saved.roomKey == null) return { text }
  // A private room's key: kept out of what the model reads.
  $.ui.log(`Studio: ${text}`)
  return { text: "The invite is printed above, not shown to the model: the link carries the private room's key." }
}

export async function runStudio($: EngineInterface, args: string): Promise<Reply> {
  const [sub = 'help', ...rest] = tokenize(args)
  try {
    switch (sub) {
      case 'status': return await status($)
      case 'models': return await models($, rest)
      case 'login': return await login($, rest[0])
      default: return { text: HELP_STUDIO }
    }
  } catch (error) {
    return { text: `studio ${sub}: ${describe(error)}` }
  }
}

// --- /room --------------------------------------------------------------

export async function runRoom($: EngineInterface, args: string): Promise<Reply> {
  const [sub = 'help', ...rest] = tokenize(args)
  try {
    switch (sub) {
      case 'create': return await create($, rest)
      case 'join': return await join($, args.replace(/^\s*join\s*/, ''))
      case 'invite': return await invite($)
      case 'attach': return await attach($, rest)
      case 'list': return { text: await listRooms($) }
      case 'leave': {
        if ((await loadSaved($)) === null && (await getJoining($)) !== null) {
          await cancelJoining($)
          return { text: 'Stopped joining.' }
        }
        const { saved, api } = await inRoom($)
        let text = 'Left the room.'
        try {
          await api.leave()
        } catch (error) {
          // Out already (removed, closed), or a room host started by hand that
          // is gone: nothing to tell, so the session lets go.
          const isGone = saved.isAttached === true && error instanceof StudioError && error.status === 0
          if (!isOutOfRoom(error) && !isGone) throw error
          text = `Left the room (${describe(error)}).`
        }
        await forgetRoom($)
        await $.ui.close({ id: PANE_ID })
        return { text }
      }
      case 'open': {
        await inRoom($)
        const view = await getRoomView($)
        await $.ui.open({ id: PANE_ID, title: `room: ${view?.room.name ?? 'room'}` })
        return { text: 'Room pane opened.' }
      }
      case 'say': {
        const { api } = await inRoom($)
        const body = args.replace(/^\s*say\s*/, '')
        if (body.trim() === '') return { text: 'Usage: /room say <message>' }
        await api.say(body)
        await refresh($)
        return { text: 'Posted.' }
      }
      case 'task': {
        const [title, ...spec] = rest
        if (title === undefined) return { text: 'Usage: /room task "<title>" [spec]' }
        const { api } = await inRoom($)
        await api.createTask({ title, spec: spec.join(' ') })
        await refresh($)
        return { text: `Task added: ${title}` }
      }
      case 'send':
        return { text: `/room ${sub} arrives with multiple rooms (PLAN.md, phase 6).` }
      default:
        return { text: HELP_ROOM }
    }
  } catch (error) {
    return { text: `room ${sub}: ${describe(error)}` }
  }
}
