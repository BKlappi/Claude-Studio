import type { EngineInterface } from 'claude-code'
import { parseInvite } from '../protocol/join'
import type { SyncState } from '../types'
import { StudioError, client, isOutOfRoom } from './api'
import { exportRoom } from './export'
import { HANDOVER_GRACE_MS, leaveAsHost, whyNobody } from './handover'
import { attachRoomHost, closeHostedRoom, createRoom, hostedInvite, isHosting } from './hosting'
import { linkIdentity } from './identity'
import { inviteText } from './invite'
import { cancelJoining, joinRoom } from './joining'
import { listRooms } from './listing'
import { studioModels } from './models'
import { PROVIDERS } from './providers'
import type { Provider } from './providers'
import { setRoomMode } from './roommode'
import { getAccount, getJoining, getRoomView, getSync, isRoomMode, loadSaved } from './state'
import { modeText } from './summary'
import { forgetRoom, post, refresh } from './sync'

export const PANE_ID = 'studio-room'

type Reply = { text: string }

const queuedText = (sync: { queued: number }) =>
  `The room host does not answer: queued (${sync.queued} waiting), sent in order once it does.`

const HELP_STUDIO = [
  '/studio status               who you are, your room, sync state',
  '/studio models [--room] [hard=<model>] [medium=<model>] [easy=<model>]   the models of the slots (opus, sonnet, haiku, fable or a full id)',
  '/studio models reset [hard|medium|easy …] | check   take your choice back (--room: the room\'s) | ask the account about the models in use',
  '/studio login [<github-login>]  link your GitHub login and the SSH key that proves it',
].join('\n')

const HELP_ROOM = [
  '/room create "<name>" [--private] [--via tailscale|funnel|cloudflared|lan]',
  '/room join <invite link>',
  '/room invite                 the link that lets someone in',
  '/room leave [--export] [--close]   the host hands the room over first (--close: closes it for everyone)',
  '/room export                 write the room\'s summary to docs/rooms/<room>.md (not committed)',
  '/room open                   show the room pane',
  '/room mode [on|off]          where what you type goes: the room (on) or your own Claude (off)',
  '/local <prompt>              one prompt to your own Claude while room mode is on',
  '/room say <message>          post to the room log (what room mode does with what you type)',
  '/room task "<title>" [spec] [--plan]  add a task to the map yourself (the coordinator makes them from what the room says); --plan: it is split into subtasks before anyone does it',
  '/room batch <seconds>        how long the coordinator waits after the last message (2-30 s; host or admin)',
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

function syncText(state: SyncState): string {
  if (state.failures === 0) return state.error ?? (state.lastOkAt === null ? 'idle' : 'ok')
  const queued = state.queued > 0 ? `, ${state.queued} queued` : ''
  return `reconnecting (${state.failures} failed${queued}): ${state.error ?? 'no answer'}`
}

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
      `sync:   ${syncText(state)}`,
      `mode:   ${modeText(isRoomMode(saved))}`,
      ...(view === null ? [] : ['', view.statusText]),
    ].join('\n'),
  }
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
  // A private room's key: kept out of what the model reads. One transcript
  // line per line of text: a newline inside one shows as `�`.
  text.split('\n').filter(Boolean).forEach((line, at) => $.ui.log(at === 0 ? `Studio: ${line}` : line))
  return { text: "The invite is printed above, not shown to the model: the link carries the private room's key." }
}

export async function runStudio($: EngineInterface, args: string): Promise<Reply> {
  const [sub = 'help', ...rest] = tokenize(args)
  try {
    switch (sub) {
      case 'status': return await status($)
      case 'models': return { text: await studioModels($, rest) }
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
        const exported = rest.includes('--export') ? `Wrote ${await exportRoom($)}. ` : ''
        // The host with others still in the room: hand it over, or close it (PLAN.md §5).
        const view = await getRoomView($)
        const others = (view?.members ?? []).filter(member => member.login !== saved.login)
        if (saved.isHost === true && view !== null && others.length > 0) {
          if (rest.includes('--close')) {
            await closeHostedRoom($)
            await forgetRoom($)
            await $.ui.close({ id: PANE_ID })
            return { text: `${exported}Closed ${view.room.name} for everyone.` }
          }
          const to = await leaveAsHost($, HANDOVER_GRACE_MS)
          if (to === null) {
            return {
              text: `${exported}Nobody else here can take over hosting ${view.room.name} (${whyNobody(view.members, view.room.hostLogin)}). /room leave --close closes it for everyone.`,
            }
          }
          await forgetRoom($)
          await $.ui.close({ id: PANE_ID })
          return { text: `${exported}${to} takes over hosting ${view.room.name}; you are out of the room.` }
        }
        let text = `${exported}Left the room.`
        try {
          await api.leave()
        } catch (error) {
          // Out already (removed, closed), or a room host started by hand that
          // is gone: nothing to tell, so the session lets go.
          const isGone = saved.isAttached === true && error instanceof StudioError && error.status === 0
          if (!isOutOfRoom(error) && !isGone) throw error
          text = `${exported}Left the room (${describe(error)}).`
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
      case 'mode': {
        const { saved } = await inRoom($)
        const [choice] = rest
        if (choice === undefined) return { text: `${modeText(isRoomMode(saved))}. /room mode on|off` }
        if (choice !== 'on' && choice !== 'off') return { text: 'Usage: /room mode on|off' }
        await setRoomMode($, choice === 'on')
        return {
          text: choice === 'on'
            ? 'Room mode on: what you type goes to the room. /local <prompt> runs one prompt here.'
            : 'Room mode off: what you type goes to your own Claude. /room mode on sends it to the room again.',
        }
      }
      case 'say': {
        const { api } = await inRoom($)
        const body = args.replace(/^\s*say\s*/, '')
        if (body.trim() === '') return { text: 'Usage: /room say <message>' }
        if ((await post($, api, { kind: 'say', body })) === 'queued') return { text: queuedText(await getSync($)) }
        await refresh($)
        return { text: 'Posted.' }
      }
      case 'task': {
        const [title, ...words] = rest
        if (title === undefined) return { text: 'Usage: /room task "<title>" [spec] [--plan]' }
        // --plan right after the title or last: a spec may speak of the flag.
        const needsPlan = words[0] === '--plan' || words.at(-1) === '--plan'
        const spec = words.filter((word, at) => !(word === '--plan' && (at === 0 || at === words.length - 1)))
        const { api } = await inRoom($)
        const input = { title, spec: spec.join(' '), ...(needsPlan ? { needsPlan } : {}) }
        if ((await post($, api, { kind: 'task', input })) === 'queued') return { text: queuedText(await getSync($)) }
        await refresh($)
        return { text: `Task added: ${title}${needsPlan ? " (it needs a plan: whoever claims it has Studio's planner split it into subtasks)" : ''}` }
      }
      case 'export': {
        await inRoom($)
        return { text: `Wrote ${await exportRoom($)}: the room's goals, decisions, open questions and tasks. It is not committed.` }
      }
      case 'batch': {
        const { api } = await inRoom($)
        const seconds = Number(rest[0])
        if (rest[0] === undefined || !Number.isFinite(seconds)) {
          const view = await getRoomView($)
          const now = view?.state?.debounceMs
          return { text: `${now === undefined ? '' : `The coordinator waits ${now / 1000} s after the last message. `}Usage: /room batch <seconds> (2-30)` }
        }
        const state = await api.setBatchWindow(Math.round(seconds * 1000))
        await refresh($)
        return { text: `The coordinator now waits ${state.debounceMs / 1000} s after the last message, ${(state.debounceMs * 3) / 1000} s at most after the first.` }
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
