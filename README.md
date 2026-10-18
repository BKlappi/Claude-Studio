# Studio

Multi-user agent rooms for Claude Code. Several people share a **room**: one
coordinator, one room log, one task map. Everyone types into their own Claude
Code; the work runs on the machine (and account) of whoever claims it.

There is no central server: each room is hosted by a member. Their mod starts
the **room host** on their machine, and the others connect to it (PLAN.md D14).

- Product spec: [studio-mod-spec.md](studio-mod-spec.md)
- Build plan: [PLAN.md](PLAN.md)

## Layout

```
.claude-plugin/         marketplace.json: the repo is a one-plugin marketplace (source ./plugin)
plugin/                 Claude Code plugin (a mod: function hooks, no build step)
  .claude-plugin/       plugin.json manifest (types/ is written by Claude Code, git-ignored)
  hooks/                hooks module: register.tsx wires commands, pane, band, room mode, sync, file tracking
  commands/             /local, a prompt command (markdown)
  protocol/             wire types, status format, join message, batching window, branch names; shared with the room host
  types/index.d.ts      the mod's $.state contract (self-contained mirror of protocol types)
  tests/                `claude plugin test` suites
  room-host/            the room host: Node 24 + Hono + node:sqlite, no build step
    src/db/migrations/  rooms, members, sessions, append-only room log, tasks, status, touches
    src/                rooms and sessions, tasks, HTTP app, SSH signature check, CLI
    test/               node:test suites (*.spec.ts: the mod's test runner takes *.test.ts)
```

The room host lives inside `plugin/` because installing a plugin copies only that
folder: the mod finds the room host at `<plugin>/room-host`.

## Install

```text
/plugin install studio --marketplace BKlappi/Claude-Studio
```

(The repo is the test repo for now; the line changes with the published one, as
does `MARKETPLACE` in `plugin/hooks/invite.ts`.) Joining a room needs nothing
more. To **host** a room, the machine also needs Node 24 and the room host's
dependencies, a one-time step `/room create` names when it is missing:

```text
! npm install --omit=dev --prefix "<the plugin's folder>/room-host"
```

## Requirements

- Node 24+ (runs TypeScript directly, ships `node:sqlite`), on the hosting machine
- pnpm, to develop
- Claude Code 2.1.287+ (mods); developed against 2.1.301

## Where it stands

Phase 1's cores are in (PLAN.md §7): `/room create` hosts a room from the mod
(room host + Tailscale, a cloudflared quick tunnel or the LAN, one restart
each), `/studio login` links your GitHub login and SSH key, `/room join <link>`
gets you in with a signed handshake (or the host person lets you in by hand),
and rooms are listed on the repo's `studio-rooms` branch (`/room list`). Phase 2
adds the pane's task actions (press a task for its spec; **Release**, **Done**,
**Blocked** for whoever claimed it; host and successors marked), a band above
the prompt and a status line when the pane is closed, and offline handling (the
mod backs off from 3 to 30 s and says "reconnecting"; `/room say` and `/room
task` typed meanwhile are sent in order once the room host answers). Phase 3 makes it
one shared room: the room reaches every pane within a moment (a long-poll); in a room,
**room mode** sends what you type to the room as yours (`/local <prompt>` runs one
prompt in your own Claude, `/room mode off` turns it off); the host's mod runs the
room's **coordinator**, which reads what people say a few seconds at a time and makes,
merges and splits tasks, turns requests down and keeps the room's decisions, all of it
said in the room; when the host leaves or their machine goes quiet, a member who can
host **takes the room over** and the others follow it; and a claimed task **runs** on
your machine as a Studio worker, here or in a worktree of its own, after you said so
for a task someone else asked for, its report posted to the room. Still to come:
planning and model slots (phase 4) onwards, and the two-machine runs (HANDOFF.md).

```text
/studio login [<github-login>]
/room create "<name>" [--private] [--via tailscale|funnel|cloudflared|lan]
/room invite                # the studio:join?... link, and what to do with it
/room join <link>
/room list                  # open rooms in this repo, and whether they answer
/room attach [<url>] [<host key>] [--room <name>]   # development, see below
/room mode [on|off]         # where what you type goes: the room, or your own Claude
/local <prompt>             # one prompt to your own Claude while room mode is on
/room batch <seconds>       # how long the coordinator waits after the last message
/room leave [--export] [--close]   # the host hands the room over first
/room export                # the room's summary to docs/rooms/<room>.md
```

The host needs Node 24, the room host's dependencies (`pnpm install` in this
repo, or the `npm install` line under Install), and cloudflared or
Tailscale for people on other networks (`winget install --id
Cloudflare.cloudflared`, `brew install cloudflared`). `/room create` checks all
of that first and names what is missing, with the line that installs it. `gh`,
signed in, lets the host check joiners' repo permission; without it every join
waits for the host person.

## Run the room host by hand

```sh
pnpm install
pnpm dev                    # room host on http://127.0.0.1:8787, db in plugin/room-host/data/
```

It prints its host key. Set `STUDIO_HOST_KEY` to keep one key across the
restarts `--watch` does (the mod sets it too, to restart a room host that died
on the same port and data). The `/host` routes take that key:

```sh
curl -s -X POST http://127.0.0.1:8787/host/rooms \
  -H "authorization: Bearer $STUDIO_HOST_KEY" -H 'content-type: application/json' \
  -d '{"name":"db work","login":"your-github-login","role":"owner"}'
# → { "room": {…}, "token": "<your session token for /v1/rooms/<id>/…>" }
```

To use that room host from the mod (a reload of the mod ends the room host it
spawned, so this is the way to work on the mod), start Claude Code with the same
`STUDIO_HOST_KEY` in its environment and run `/room attach`. It takes the
room host at `http://127.0.0.1:8787` unless given another loopback address, joins
the one open room there (`--room <name>` picks one; with none open it makes
`dev`), and pending joins and `/room invite` then work as after `/room create`.
The host key never leaves the machine: only loopback addresses are accepted. A
reload of the mod forgets the attachment; run `/room attach` again.

`node plugin/room-host/src/index.ts --port 0 [--data <dir>]` is the form the host's
mod starts. It listens on 127.0.0.1 only, keeps its data in memory unless given
`--data`, and writes one JSON line per event on stdout (`ready` with port and
host key, `room-closed`, `exiting`). It exits once its last room closes,
deleting its data. Joining is `POST /join/nonce`, `POST /join` and, while the
host person decides, `GET /join/tickets/<ticket>` (plugin/room-host/src/joins.ts).

## Checks

```sh
pnpm test                   # room host (node:test) + mod (claude plugin test)
pnpm validate               # claude plugin validate plugin
pnpm typecheck              # room host, then the mod (after one `pnpm studio` run lays its types)
pnpm studio                 # = claude --plugin-dir ./plugin
```

The room pane draws in the terminal and the Desktop app's Code tab, not in the
VS Code extension's chat panel. An unasked pane waits for a terminal 144
columns wide; `/room open` asks for it directly.
