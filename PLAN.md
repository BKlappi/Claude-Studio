# Studio — Build Plan

Source of truth for *what* to build: [studio-mod-spec.md](studio-mod-spec.md), as amended by
[§3 Changes to the spec](#3-changes-to-the-spec). This file is the *how* and *in which order*.
Tick boxes as work lands; when a decision changes, edit its entry in §2 instead of adding one.

Phases 1–8 follow the spec's Build Order. Phase 0 is the groundwork already in the repo.

---

## Contents

1. [Where we are](#1-where-we-are)
2. [Decisions](#2-decisions)
3. [Changes to the spec](#3-changes-to-the-spec)
4. [Still open](#4-still-open)
5. [How the spec's open questions are answered](#5-how-the-specs-open-questions-are-answered)
6. [Architecture](#6-architecture)
7. [Phases](#7-phases)
8. [Cross-cutting work](#8-cross-cutting-work)
9. [Risks and spikes](#9-risks-and-spikes)
10. [Next tasks](#10-next-tasks)

---

## 1. Where we are

### Phase 0 — Groundwork (done)

A walking skeleton: a server you can run and a mod that talks to it. It was built as a
**central** server; §2 D14 moved to **member-hosted rooms**, and phase 1 reshaped that server
into the **room host** (`plugin/room-host/`, D25), the process a member's mod starts on their own machine.

**Server** (as built in phase 0; now `plugin/room-host/`, see phase 1)
- [x] Schema: rooms, room members, append-only room log, tasks, room status, file touches
      (keeps) · teams, invites, device codes (go away in phase 1: team = GitHub repo)
- [x] Bearer tokens stored as sha256 (keeps, as per-room session tokens)
- [x] Rooms: create, list, join, leave, host handover inside one process
- [x] Room log: append-only, per-room `seq`, cursor reads (`snapshot?since=`)
- [x] Tasks: create, atomic claim (one winner), release, versioned state change
- [x] Room status in the spec's plain-text format; `touching` from file touches
- [x] File touches: report, list
- [x] Private rooms hidden on the server side
- [x] 8 tests

**Mod** (`plugin/`)
- [x] `/studio login | logout | status | invite | models` (models stored, not used yet)
- [x] `/room list | create | join | leave | open | say | task` (`invite`, `send` stubbed)
- [x] Room pane: room, host, members, task map with **Claim** buttons, room log, sync errors
- [x] Sync loop: polls the room every 3 s, merges by log cursor
- [x] File tracking: successful `Edit` / `Write` / `NotebookEdit`, project-relative, queued
      (a tool call never waits on the network); paths outside the project never sent
- [x] Resume on session start; `claude plugin validate` clean; 6 tests (`pnpm test:plugin`)

**Shared**: `plugin/protocol/` — wire types + status format, imported by both sides.

Phase 1's Opus work is in (2026-10-17): the mod hosts a room (room host + address provider,
restarts), joins by invite link (SSH-signed handshake, GitHub permission, room key), and keeps
the room directory branch. Its Sonnet items are built too (2026-10-17): the host check,
`/room list`, `/room invite`'s wording, the pane's address line and `/room attach`; the two
that touch untrusted input or the host key had their §8 Opus read the same day (§7). The
two-machine run passed its main rows the same day (Windows host, macOS joiner, §7); left are
its read-only, private-room and manual-admit rows (§10).

Phase 2 is built (2026-10-18; its two-machine run is left). Phase 3 is built (2026-10-18):
its Sonnet items (presence, room mode and `/local`, the batching countdown, the approval
card, task branch names) and its Opus items (the long-poll, the coordinator, handover,
running claimed work), with spike 3 on the real CLI (§9). Its two-machine run is left
(HANDOFF.md §5 has the script).

Phase 4 is built (2026-10-18): its Opus items (the planner D28, the reviewer D29, the
escalation rule, with the §8 read) and its Sonnet items (`/studio models` with the account
check, short names, room defaults and own overrides D30, per-slot worker types, the pane's
slot and attempts, the plan card, `/room task --plan`). Nothing of phase 4 has run on a real
room yet: HANDOFF.md §6 is the spike.

Not there yet: limit handoff, cross-room features, overlap threads.

---

## 2. Decisions

| # | Decision | Why | Revisit when |
|---|---|---|---|
| D1 | **Node 24, TypeScript run directly**, no build step, pnpm workspace | Fewest moving parts | Hosts without Node become common (see D20) |
| D2 | **Hono** for HTTP | Tiny, typed, `app.request()` tests | — |
| D3 | **SQLite on the host's machine**, in memory by default, or one file under `--data` (survives a room-host restart); **deleted when the room host's last room closes** | Rooms are ephemeral (D18) | — |
| D4 | **Room log is the room's source of truth while it is open**; tasks/status are projections written in the same transaction | Rebuild a coordinator after handover; idempotent commits | — |
| D5 | **Long-poll** (phase 3): the snapshot route holds a request with `waitMs` (25 s at most) until the log grows; no SSE, no WebSocket | A mod has only `$.http.fetch` (spike 3: it waits 25 s fine); quick tunnels do not carry SSE | Mod API gains streaming fetch |
| D7 | **`plugin/protocol/` is the shared package**; room host imports it by relative path | A mod may import only files inside its folder | — |
| D8 | **Mod state rules**: atoms only in `hooks/state.ts`; `$`-taking helpers are `function` declarations; contract `types/index.d.ts` self-contained, checked against protocol | `claude plugin validate` requires it | Validator changes |
| D10 | **Coordinator = model calls from the host's mod** (`$.model.complete`), not the host's main conversation | Keeps the host's session clean; cheap; structured actions we validate | Never needs a server now: it already runs where the room runs |
| D11 | **Workers = subagents** (`$.agent.spawn`) of Studio's own types (`studio:worker`, `studio:worker-worktree` with the engine's `isolation: 'worktree'`), hidden from the model, model by the task's difficulty slot (the type's model: the spawn's `model` takes aliases only), a tool allowlist, **started only inside one of Studio's hook dispatches** (a press, a `turn.complete`): the engine runs none of a plugin's hooks on the calls of an agent the plugin's background code started (spike 4), so Studio's `agent.spawn` hook hands over the run's prompt and anything else gets a placeholder | Spec: per-subagent model; security. Spike 3: `$.agent.spawn`'s `cwd` is not honoured, the engine's isolation is. Spike 4: the holds and the review's record of commands live in Studio's own hooks | `cwd` starts working (then a worktree of Studio's own, off the room's base branch); the engine lets a plugin hook its own agents from anywhere |
| D12 | **Private rooms are members-only**, admins included | Spec; simplest rule to audit | — |
| D13 | IDs are UUIDs; room names unique per directory (D17) | — | — |
| D14 | **No central server. Each room is hosted by a member**: the host's mod starts a room-host process on their machine; other members' mods connect to it | Your call: nobody runs a server for the team | — |
| D15 | **The room host runs as a child of the host's Claude Code** (`$.process.spawn` from `session.start`/`/room create`): it lives as long as the host's session | Clean lifecycle, no orphan processes. Spike 2 (§9): the engine ends the child when the loop ends, when Claude Code exits, and even when it is force-killed (Windows) | Orphans on macOS/Linux after a crash; or people want rooms to survive a Claude Code restart |
| D16 | **Reachability through an address provider**, picked automatically: **Tailscale** if running (tailnet name, or Funnel for people off the tailnet) → **cloudflared quick tunnel** if installed (only the host installs anything) → **LAN** with a warning | NAT: a laptop is not reachable from the internet by default | — |
| D17 | **Room directory = an orphan branch `studio-rooms` in the shared repo** (`rooms.json`: room id, name, host, address, updated). Written by hosts only on create, host change and close; read by `/room list` and after a host vanishes. Private rooms appear only encrypted with the room key | Discovery and host re-election without a server, using git access the team already has. Approved (was Q8) | The team dislikes commits on a side branch: then rooms are shared by link only, and a crashed host needs a re-shared link |
| D18 | **A room closes when its last member leaves**: the host process exits, its directory entry is removed, its data is deleted | Your call | Someone asks for history: optional "export summary to repo" on close (§4) |
| D19 | **Team = collaborators of the shared GitHub repo**; roles from repo permissions: repo/org owner → owner, admin → admin, maintain/write → member, read-only → no access | No team registry needed; matches "one repo per room" | — |
| D6 | **Identity = GitHub login, proved without sending a secret**: the joiner signs the join message (`plugin/protocol/join.ts`: room, dialled origin, login, host nonce) with `ssh-keygen -Y sign`, using a key that GitHub lists at `github.com/<login>.keys`; the host verifies in Node (`room-host/src/sshsig.ts`, no OpenSSH on the host). The host checks the joiner's repo permission with its own `gh`. No proof or no `gh` → the host admits by hand ("unverified") | An OAuth web flow needs a server holding a secret; sharing a token with a peer is worse. Spike 1 confirmed it on Windows (§9) | macOS/Linux check in the phase 1 two-machine run fails |
| D9 | **Per-room session token** issued by the host after admission; kept in `$.store`, dropped when the room closes | Short-lived, room-scoped | — |
| D20 | **The host needs Node 24** (the room host is Node). Joiners need only Claude Code, git and an SSH key on GitHub | Reuses the server code as is | Ship a single binary (`bun build --compile`) if Node on hosts is a problem |
| D21 | Shared input = **room mode** (prompts go to the room while in a room) | Your call (was Q1) | — |
| D22 | **One repo per room**, defaulting to the team's repo; the mod checks `origin` on join | Your call (was Q4) | — |
| D23 | **Tasks from other members always ask first** (`Run here` / `Run in worktree` / `Not now`, worktree preselected) | Your call (was Q5) | — |
| D24 | **Build with Sonnet by default, Opus where a mistake is expensive or hard to see** (§8 "Which model builds it"): security, distributed state, the agents' instructions, first use of an early-access mod API, contract-wide refactors, bugs that resisted two tries. Each phase names its Opus items | Most tasks follow a pattern already in the repo; Opus uses more of the plan's limits | A task class keeps escalating, or a model release changes the gap |
| D26 | **Following a room to a new address**: the room host there must answer the member's nonce with `HMAC(room secret, room, the dialled origin, nonce)` (`protocol/seal.ts hostProof`; only for its own addresses); then the member joins again on its SSH signature, and the new host's carried-over roster lets it in in its role (no `gh` check). A session token never goes to a new address, a quick tunnel's new name included. The secret comes with members' snapshots and is renewed when someone is removed | The directory is writable by anyone with push access; every member holds the secret, so a proof shows "the room's", not "not a member's imitation": a signature bound to the address and nonce is worth nothing elsewhere, a token would be | The mod gains signature verification (`crypto.subtle.verify`): then the host could sign with a key of its own |
| D27 | **The room host times the coordinator**: `GET /host/rooms/:id/coordinator` is held until the batching window of the unread messages closes, on the room host's clock, which also reports the window to members; the host's mod commits `{ fromSeq, upToSeq, baseVersion, actions }`, applied once | One clock for the countdown and the read; nothing to remember in the mod across failures or a handover | — |
| D28 | **Planning is a run of the task, on its claimer's machine**: the coordinator only flags `needsPlan`; whoever claims and runs the task gets Studio's planner (the `hard` slot, read-only tools held to the checkout and away from secrets) instead of a worker, after the same approval card. Its plan is checked on both sides and becomes subtasks on the map; the task is done | D23: nothing shaped by others' words runs unasked on a machine; the claimer pays (spec, "Billing"); the planner needs the repo, which the claimer has | Hosts want plans made before anyone claims: then the host's mod plans, with the same tools and holds |
| D29 | **Review = one model call, no tools, over evidence Studio gathered**: git's diff from where the run started, the files it wrote, the commands the engine saw the worker run and their output, the worker's report as a claim. The escalation rule is applied by the room host, so its outcome is the room's; a failed review starts the next attempt at once | A reviewing agent would need Bash on the person's machine and the worker's worktree, which `$.agent.spawn`'s ignored `cwd` cannot give; what really ran is better evidence than the worker's word; nothing new runs | Reviews pass work that fails on the person's machine: then a reviewer agent that runs the checks itself, in the worker's folder once `cwd` works |
| D30 | **Model slots resolve own → room → Studio's**: the host or an admin sets the room's defaults on the room host (`rooms.models`, `PUT /v1/rooms/:id/models`, in every snapshot's `Room`, carried by a handover); a member's own choice stays in their `$.store` and never leaves their machine. The coordinator, the planner, workers and reviewer all take the slot's model this way, on whoever's machine runs them. Selecting a model asks that person's account once (`hooks/models.ts`) and warns | Spec: "room owner sets room defaults; members can override for the work their own machine runs"; every machine pays with its own account, so only that account can say whether it can use a model | A room wants to force a model for everyone: then a room-level lock the mod honours |
| D25 | **The room host lives in `plugin/room-host/`**, the repo is a one-plugin marketplace (`.claude-plugin/marketplace.json`, `source: "./plugin"`). An installed plugin has no `pnpm install`: `/room create` names the one-time `! npm install --omit=dev --prefix "<plugin>/room-host"` | `claude plugin install` from a local marketplace copied only `plugin/` into the cache (tried 2026-10-18), so `<plugin>/../room-host` did not exist on an installed machine | A bundled single-file room host (phase 8) removes the npm step and the Node-24 need |

---

## 3. Changes to the spec

What D14–D19 change in `studio-mod-spec.md`. (Say the word and these get folded into the spec itself.)

| Spec says | Now |
|---|---|
| Architecture: "Server + thin clients"; the server stores teams, members, roles, rooms, logs, task maps, statuses, file tracking | A **room host** per room, run by a member; it stores that room's log, task map, status and file touches while the room is open. No team server |
| Team: "created by an owner (on a website or via command); members join via invite" | Team = collaborators of the GitHub repo; nothing to create |
| Roles table (owner/admin/member) | Same three roles, derived from repo permissions (D19) |
| `/studio login`: browser sign-in, links Claude Code to the team | Links your GitHub login and SSH key once; no browser needed |
| "If the host leaves, hosting hands over"; "an empty room is never lost: whoever joins next rebuilds the coordinator from the log" | Hosting hands over while someone is in the room. **An empty room closes and is gone** |
| "Later: server-side coordinator" | Dropped: the coordinator already runs on the host |
| "All active open rooms are visible in the room list" | Via the room directory branch (D17) |
| File tracking: "the mod reports every edit to the server"; "every room can see which files other rooms are working on" | Reported to your room's host; other rooms' touches are read from their hosts, found through the directory |
| Security: "Private rooms are hidden from non-members on the server side" | Hidden by the room host; the host itself necessarily sees everything in rooms it hosts |

---

## 4. Still open

Nothing open blocks the next phase.

Answered: Q8 (directory branch) = yes, now D17. Q6 (keep anything when a room closes?) =
nothing by default; `/room export` or `/room leave --export` writes `docs/rooms/<room>.md`
(phase 3). Q7 (who may host?) = anyone whose machine passes the host check with a provider
beyond the LAN and has a clone of the room's repo; each mod reports it, the pane shows who
could take over and warns when nobody could (phase 3).

---

## 5. How the spec's open questions are answered

### Onboarding: from "a friend sent me an invite" to "my message reached the agents"

Target: **one install line, one command.**

1. The host runs `/room invite` (or `/room create` prints it): a link such as
   `studio:join?room=<id>&at=<address>` (plus the room key for a private room), and the
   install line `/plugin install studio --marketplace <owner>/<repo>`.
2. The friend pastes both. `/room join <link>`:
   - the first time only, links identity: reads the GitHub login (`gh api user`, else
     `git config github.user`, else asks once) and picks the SSH key GitHub lists for it;
   - signs the host's nonce, sends login + signature;
   - the host verifies it and checks repo permission (D6, D19) and admits, or asks the
     host person to admit by hand.
3. Joined: pane opens, room mode turns on (D21), the band says
   `room: frontend — prompts go to the room`.
4. The first prompt typed lands in the room; others see it within a second (long-poll);
   the coordinator answers within the batching window.

Open rooms can also be joined by name: `/room list` reads the directory branch.

### Host handover: what happens to in-flight work when the host leaves mid-turn

- **Workers** run on the claimer's machine, never the host's: unaffected. Their mods queue
  results while the host is unreachable and send them to whoever hosts next.
- **Every member's mod mirrors the room**: room state document, task map, member list,
  log since the coordinator's cursor (enough to continue: spec, "any agent must be able to
  pick up a task from the room state + task map alone").
- **The coordinator step is idempotent**: the host stores `coordinatorCursor` and the state
  document's `version`; a batch commits as `{ upToSeq, baseVersion, actions }` and applies
  only if both still match. A half-processed batch is simply processed again.
- **Successor** = the longest-present member whose machine can host (Q7).
- **Host leaves on purpose** (`/room leave`, or quitting Claude Code): the host posts
  `handover → <successor>` and stops. The successor's mod starts its own room host seeded
  from its mirror, publishes the new address in the directory, and posts "Ana now hosts".
  Everyone else's mod follows the `handover` entry and reconnects.
- **Host vanishes** (crash, sleep, network): members' long-polls fail for 30 s. Candidates
  wait their turn in successor order (15 s apart), read the directory, and re-host only if
  nobody did yet; publishing is a git push, so a second candidate's push is rejected and it
  connects to the winner instead. Others poll the directory for the new address.
- **Nobody can host** → the room closes, with a note in the pane before it happens.
- Messages typed during the gap stay queued in the sender's mod and are sent after
  reconnecting, in order, author-tagged.

### Batching window length

- **Debounce 4 s after the last message, capped at 12 s after the first**; per-room setting
  (2–30 s); countdown in the pane ("coordinator reads in 3 s…").
- Tune with real use in phase 3.

---

## 6. Architecture

```
            ┌─────────────── Ben's machine (host of "frontend") ───────────────┐
            │  Claude Code + studio mod                                         │
            │   pane, band, room mode, file tracking                            │
            │   coordinator ($.model.complete), planner + workers (subagents)   │
            │        │ $.process.spawn                                          │
            │        ▼                                                          │
            │  room host (Node: log, tasks, status, touches; 127.0.0.1 only)    │
            │        │                                                          │
            │  address provider: tailscale / cloudflared quick tunnel / LAN     │
            └────────┼──────────────────────────────────────────────────────────┘
                     │ HTTPS (long-poll + REST), per-room session tokens
        ┌────────────┴──────────────┐
  Ana's Claude Code + mod     Cem's Claude Code + mod        GitHub repo
  pane, room mode, workers    pane, room mode, workers       ├─ main (code; read by all rooms)
  mirror of room state        mirror of room state           └─ studio-rooms (directory, D17)
```

- The **room host** never calls a model and never holds model credentials. It stores,
  orders, authorizes, and answers long-polls. It listens on `127.0.0.1` only; the address
  provider exposes it.
- **Every mod**: draws the room, forwards input, reports file edits, runs what its person
  claims, mirrors the room for handover.
- **The host's mod** also starts the room host, the tunnel, and runs the coordinator.
- **Cross-room** (phase 6–7): mods read other rooms' status and touches from their hosts,
  found through the directory. No room loads another room's log.

### Mod API map

| Feature | Claude Code mod API |
|---|---|
| Start/stop room host, tunnel | `$.process.spawn` (child lives with the module; leaving the loop kills it) |
| Identity proof, repo checks, directory | `$.process.run` (`ssh-keygen`, `gh`, `git`) |
| Room pane | `$.ui.open` + `ui.render` on `{ component: 'Pane' }` |
| Band (room mode, presence) | `ui.render` on `{ component: 'AbovePrompt' }`, `$.ui.status` |
| Commands | `$.command.register` + `command.run` |
| Room mode | `prompt.submit` → `{ drop }` + post to room |
| Coordinator | `$.model.complete` (cached instruction block) from `$.clock` timers |
| Planner, workers, reviewer | `$.agent.register` per slot, `$.agent.spawn({ subagentType, model, prompt, cwd })` |
| File tracking, overlap prompt | `tool.call` on `Edit` / `Write` / `NotebookEdit` |
| Usage limits | `session.measure` (`rateLimits[].percentUsed`), turn errors `rate_limit` |
| Host leaving | `session.end` (short bound: post handover, stop) |
| Network, timers, storage | `$.http.fetch`, `$.clock.every/after`, `$.store` |

---

## 7. Phases

Every phase ends with: tests green, `claude plugin validate` clean, the phase's manual
checklist run with **two machines (or two terminals with two GitHub logins)**, PLAN.md ticked.

Each phase's **Model** line says which items to build with Opus; the rest is Sonnet's
(D24, §8 "Which model builds it").

### Phase 1 — Member-hosted room basics (spec step 1, reshaped)

Goal: Ben runs `/room create`, Ana joins from another network, both see the same room.
No server anywhere.

**Model**: Opus for the join handshake (route, rate limit, permission mapping, room key),
the directory branch (concurrent pushes, private-entry encryption) and the hosting core
(spawn loop, restarts, address providers, the DNS wait). Sonnet for the host check and its
messages, `/room invite` text, `/room list`, the pane's address line, the dev attach path,
and fixes from the two-machine run.

Room host (`plugin/room-host/`, done 2026-10-17)
- [x] `server/` → `room-host/`; teams, invites, device flow and sign-in page gone; members
      are GitHub logins (lowercased), with a `verified` flag and the key fingerprint used
- [x] CLI: `node room-host/src/index.ts --port 0 [--data <dir>]` → loopback only; one JSON
      line per event on stdout (`HostEvent`: `ready` with `port` + `hostKey`, `room-closed`,
      `exiting`); in memory unless `--data`. Never reads standard input. Exits when killed,
      on `POST /host/close`, or when its last open room closes, deleting its data then;
      macOS/Linux orphan guard (parent id changes). The repo is per room (`repoUrl` at
      create), so no `--repo`. The mod gives it `~/.claude/studio/room-hosts/<id>`
- [x] Bind `127.0.0.1` only; `/health` public; `/v1/*` needs a per-room session token
      (one per member per room; a new admit replaces it; a token opens its own room only,
      others answer 404; a closed room answers 410); 256 KiB body limit
- [x] Join route (`src/joins.ts`): `POST /join/nonce` (one try, 2 min, bound to its room),
      `POST /join` (origin must be one the host set with `PUT /host/origins`, or its loopback
      one; room key for private rooms; signature against `github.com/<login>.keys`; repo
      permission through the host's `gh`, `src/access.ts`), `GET /join/tickets/<ticket>` while
      the host person decides (`GET /host/joins`, admit / refuse). Rate limits per minute:
      overall, per client address, per login; at most 10 waiting per room. Nobody unverified
      takes the place of a verified member, by any route
- [x] Restart on the same port, data folder and host key (`STUDIO_HOST_KEY`) carries on with
      its rooms; a killed host's data folder is swept by the next one spawned beside it;
      `src/relay.ts`, the LAN provider's TCP relay (the room host stays on loopback)
- [x] Versioned migrations (`src/db/migrations/NNN-*.sql`, `PRAGMA user_version`; a newer
      database is refused); triggers refuse `UPDATE`/`DELETE` on `room_log`
- [x] Host routes (Bearer `hostKey`): create room (the host joins as first member; private
      needs owner/admin), admit (verified or by hand), kick, close room, list rooms, close
      the process
- [x] The host leaves last: while others are in the room `/leave` answers 409 (handover is
      phase 3); the last one out closes the room (D18)
- [x] 48 room-host tests (`pnpm test:host`), the CLI and the relay as real child processes,
      signatures made with node:crypto in SSHSIG form (`test/keys.ts`)

Mod: follows the room host (done 2026-10-17)
- [x] One client per room session (`hostUrl`, `roomId`, token, login in `$.store` key
      `room`); 401 / 404 / 410 → the mod forgets the room (toast says why); resume at start
- [x] Pane: logins, "hosted by", unverified members marked; `userConfig.serverUrl` gone
- [x] 11 mod tests, a fake room host among them (`tests/room.test.ts`: resume, pane, Claim,
      closed room, stale session, leave)

Mod: hosting, joining, directory (Opus cores, done 2026-10-17; `tests/hosting.test.ts`,
`tests/join.test.ts` on `tests/fakes.ts`: fake children, commands, URLs and a git remote; 30 mod
tests then, 52 with the Sonnet items below: `tests/list.test.ts`, `tests/attach.test.ts`, the
host check and invite cases in `tests/hosting.test.ts`; 56 after the Opus read)

Mod: hosting
- [x] Spike 2 (§9): a mod command spawns the room host and `cloudflared`, reads both
      outputs, reaches the room over the public address, and ends both
- [x] Host check (`hooks/hostcheck.ts`, before `/room create` starts anything): `node --version`
      ≥ 24, the room host's files and installed dependencies beside the plugin
      (`$.fs.exists`), and, for `--via`, that provider (`cloudflared` installed, Tailscale
      running). Every problem is named once with its install line for the machine
      (`winget` / `brew` / a download page; the platform is guessed from the home folder).
      Auto with neither Tailscale nor cloudflared still opens the room on the LAN, and the
      reply says what to install. Tests: `tests/hosting.test.ts`
- [x] `/room create "<name>" [--private] [--via tailscale|funnel|cloudflared|lan]`
      (`hooks/hosting.ts`): host role from `gh api repos/{o}/{r}` (D19; no gh → member; no
      repo → owner), room host spawned (`--port 0 --data ~/.claude/studio/room-hosts/<id>`,
      host key in its environment), room created, then in the background: provider, its
      address set as the room host's origin, invite link as a transcript line, directory
      entry. A command's hook may not wait on `$.clock` for long (10 s budget), so the
      waiting is background work and the pane says how far it got
- [x] Address providers (`hooks/providers.ts`): `tailscale` (`tailscale serve --http=<port>`
      in the foreground, so the config goes with the child), `funnel` (`--https=443`, only
      when asked), `cloudflared` (URL from its output, `Registered tunnel connection`, then
      DNS over HTTPS until the name exists, then `/health` through it), `lan` (relay, warned).
      Auto order D16, falling through to the next on failure. Tailscale is untried on a real
      tailnet (no Tailscale here): first thing the two-machine run checks
- [x] The invite link goes out only once the address answers; a joiner whose lookup fails
      (`ENOTFOUND`) retries every 5 s for 90 s (`hooks/joining.ts`)
- [x] Room host or tunnel dies → pane shows it; one automatic restart each (room host: same
      port, data, key; tunnel: a quick tunnel's new address is set, published and logged);
      then "room lost": children stopped, the room forgotten, the entry removed. A session
      that hosted and reloads forgets the room (its room host died with the reload)
- [x] Members follow an address change by themselves (done in phase 3, with handover:
      after 30 s without an answer a member reads the directory, checks the host proof at
      the new address and joins again on its signature, D26; the token stays behind)
- [ ] Later: a detached room host surviving a Claude Code restart (D15 revisit)
- [x] Dev attach, `/room attach [<url>] [<host key>] [--room <name>]` (`hosting.ts`
      `attachRoomHost`): the session uses a room host started by hand (`pnpm dev`), because a
      reload of the mod ends a spawned one. Loopback addresses only (the host key never goes
      further); the key comes from the command or `STUDIO_HOST_KEY` and is kept in module
      memory, never `$.state`, never saved. It joins the only open room (or `--room`, or makes
      `dev`) and takes a fresh token for the host person through `POST
      /host/rooms/:id/members`; pending joins and `/room invite` (the loopback link) work;
      leaving lets go without stopping the room host; a reload forgets the attachment with a
      toast. Private rooms are refused (their key is shown once). Tests: `tests/attach.test.ts`,
      and run against a real `pnpm dev` room host. §8 Opus read done 2026-10-17: the key goes
      to the checked loopback origin only, and into no state, store, log line or reply; the
      re-issued token's login, role and room all come from one `/host/rooms` answer (a room
      not listing its host among its members is refused, no `owner` fallback). Fixed then: a
      room host that stopped no longer traps the session (`/room leave` lets go when it does
      not answer, or answers 401/404/410), and one restarted with a new key shows in
      `/studio status` instead of pending joins silently stopping

Identity and access
- [x] Spike (§9): sign with `ssh-keygen -Y` on Windows (both OpenSSH builds, agent and disk
      keys), verify in Node, fetch `github.com/<login>.keys` → `room-host/src/sshsig.ts`,
      `room-host/src/github.ts`, `plugin/protocol/join.ts`, tests with real signatures
- [x] macOS: sign, verify against the Windows host (two-machine run, 2026-10-17)
- [ ] Linux: sign, verify against the Windows host
- [x] `/studio login [<login>]` = link identity (`hooks/identity.ts`): login from the argument,
      `gh api user` or `git config github.user`; key: one `github.com/<login>.keys` lists, held
      by the agent (signed through its `.pub`), else a key file without passphrase; else linked
      without a key, saying what to do. In `$.store` key `identity`
- [x] Join handshake: `POST /join/nonce` → `ssh-keygen -Y sign` → `POST /join` → host
      verifies, checks repo permission via `gh api repos/{o}/{r}/collaborators/{login}/permission`
      (`role_name`; org owners via `orgs/{o}/memberships/{login}`), maps role (D19) → session
      token. No proof, or no permission answer → the host person sees "<login> wants in" with
      **Let in** / **Refuse** in the pane; the joiner's mod polls its ticket. Read-only → 403
- [x] Private rooms: room key (made by the room host, kept as a hash) in the invite link,
      required at join, on top of identity; the link is printed as a transcript line, never
      in what the model reads
- [x] `/room join <link>`
- [x] `/room invite` (`hooks/invite.ts`): the link, what the other person does with it, the
      provider's caveat (tailnet / LAN only); a private room's text goes to `$.ui.log`, out of
      the model's reading. The install line (`/plugin install studio --marketplace
      <owner>/<repo>`) is there once `MARKETPLACE` in `hooks/invite.ts` is set: phase 2's
      "Ship" does that, as the plugin has no repo yet. The pane's address line says each
      `HostingView.phase` in words (`hostingLine` in `hooks/pane.tsx`)

Directory (D17)
- [x] `rooms.json` on orphan branch `studio-rooms` (`hooks/directory.ts`): written on create,
      address change and close, with git plumbing instead of a temp worktree (`ls-remote`,
      fetch by id with `--no-write-fetch-head`, `hash-object`, `mktree`, `commit-tree`, push;
      nothing checked out, no local ref written); a lost race (non-fast-forward) is read again
      and replayed, five tries. The host's own entries that no longer answer are dropped on
      create. Entries read from the branch are validated (anyone with push access writes it).
      A session that ends without closing leaves its entry (the 1.5 s `session.end` bound has
      no room for a push); the next create by the same login drops it
- [x] `/room list` (`hooks/listing.ts`) merges the directory with the room you are in: host,
      age, and whether the address answers (`GET /health`, 5 s, answer unread); an open room that
      answers comes with its `/room join` link; private entries open only with the key you
      hold (your own room's) and are otherwise left out; names and hosts from the branch are
      cut to one plain line (control and bidi characters removed). Tests: `tests/list.test.ts`.
      §8 Opus read done 2026-10-17, and tightened then: an entry is read only with a room id,
      a GitHub login as host, a finite time and an address off the reader's machine (no
      127.x, 0.x or localhost, in any spelling `URL` accepts); names are quoted, since the
      model reads the reply; `/room create` asks at most 10 of the host's own older entries,
      in parallel with the 5 s limit (it asked all, one by one, without one); git's message
      has a remote URL's credentials masked. What stays: an entry may name a LAN address (the
      LAN provider needs that), so a hostile one has each reader's machine send a blind
      `GET /health` there; and its name and host are claims, not proof (joining one gives that
      address only a signature bound to its own origin and nonce; host identity is phase 3)
- [x] Private rooms: entry sealed with the room key (`protocol/seal.ts`: HKDF-SHA256 keys,
      HMAC-SHA256 keystream and tag, as the mod has SHA-256 alone; checked against node:crypto
      and the RFC vectors). Only id and time are readable

Done when: Ben creates a room on a laptop behind home NAT; Ana, on another network with
only Claude Code + git + an SSH key, joins by link; both see members and tasks; a read-only
collaborator is refused; when both leave, the process exits and the directory entry and
data are gone.

Two-machine run, 2026-10-17 (host: Windows 11, Claude Code 2.1.302, Node 24.11.1, cloudflared
2026.10.1; joiner: macOS, its own GitHub login with write access; test repo
`BKlappi/Claude-Studio`), rows from HANDOFF.md's script:
- Passed: create with `--via cloudflared` (the link 2–3 s after create, not the 20–60 s
  expected); a signed join from macOS, verified; `/room list`; a task and a message seen
  within ~3 s; the claim race (one winner, the other a "Claim failed" toast); `touching` after
  an `Edit`; the host refused leaving first; both left → no process, no folder, `rooms.json`
  empty; the tunnel killed twice (a restart at a new address, logged and published, then
  "room lost" and the entry removed).
- Not run yet: a read-only collaborator refused, a private room joined with and without its
  key, a join without a usable key (**Let in**), Tailscale and Funnel (no tailnet), Linux.
- Found: a newline inside one `$.ui.log` line shows as `�` (the invite line); fixed, one line
  each. A file written through `Bash` is not tracked (only `Edit` / `Write` / `NotebookEdit`
  are). On Windows a lost room leaves its data folder (the room host is killed, never asked
  to stop); the next `/room create` sweeps it.

### Phase 2 — Mod v0 complete (spec step 2)

**Model**: Sonnet for all of it: UI, offline handling, tests and shipping follow what is
already there.

- [ ] Manual checklist (two machines): create, invite, join, add task, claim race (one
      winner; loser gets a toast)
- [x] Pane: "mine" first; press a task to expand its spec; **Release**, **Done**, **Blocked**
      for the claimer; host and possible successors marked (done 2026-10-18, `hooks/pane.tsx`.
      A blocked task shows **Resume** in place of Blocked. Successors are the verified members
      in joining order, `ben (host), ana (successor 1)`; the per-member "can host" flag is
      phase 3, Q7. `setTaskState` is in `hooks/api.ts`; a stale version is a 409 and a toast)
- [x] Band when the pane is closed or narrow: `frontend · 3 open · you: 1 claimed`
      (`hooks/band.tsx`: shows unless `$.ui.panes()` lists the pane shown *and* placed, so a
      terminal too narrow for the pane gets the band. It also says "reconnecting", queued
      messages and who waits to be let in; a survey holds the band and it yields. Redrawn
      with each poll, since the sync state it reads is written then)
- [x] `$.ui.status`: room + connection state (`studio · frontend · online`; `reconnecting`,
      `2 queued`, or the hosting phase; cleared on leaving)
- [x] Offline handling: backoff 3 s → 30 s, "reconnecting", queued file reports and messages
      (`hooks/sync.ts`: a `clock.after` chain, `pollDelay`: 3, 3, 6, 12, 24, 30 s; `post()`
      queues `/room say` and `/room task` while the room host does not answer (status 0 or
      5xx, which includes a tunnel's 502), in order, 50 at most, in memory; one the host
      refuses for good is dropped with a toast. 401/404/410 still mean "out of the room")
- [x] Tests: pane on `terminal` and `desktop` with signed-in fake state; commands against a
      fake room host (answer `http.fetch` from the test's own hooks) (`tests/pane.test.ts`,
      `tests/offline.test.ts` on `memberWorld` / `fakeRoomHost` in `tests/fakes.ts`; 72 mod
      tests, 48 room host tests)
- [x] Ship: `.claude-plugin/marketplace.json`, README install line, GitHub repo; then set
      `MARKETPLACE` (`<owner>/<repo>`) in `hooks/invite.ts` so `/room invite` carries the
      install line (done 2026-10-18 with the test repo `BKlappi/Claude-Studio`: change it
      and the README line before publishing. D25: the room host moved into
      `plugin/room-host/`, its tests are `*.spec.ts`; `claude plugin install` from a local
      marketplace now lands `room-host/` in the cache. The host check names the npm line
      for an installed plugin and `pnpm install` for the repo)
- [ ] A host restart heals: proved in `tests/offline.test.ts` (same token, nothing forgotten,
      what happened meanwhile arrives once); still to see on two real machines

Done when: two members see the same task map within ~3 s, the claim race always has one
winner, and a host-side restart heals without user action.

### Phase 3 — One shared room (spec step 3)

**Model**: the Opus phase. Opus for the coordinator (instructions, action schema,
validation, idempotent commit), all of handover, the long-poll on the room host, and running
claimed work (the `$.agent.spawn` + worktree spike, fencing, what a run may touch). Sonnet
for presence, the room-mode hook and `/local`, the batching countdown, the approval card's
UI and task branch names.

Push and presence
- [x] Long-poll (done 2026-10-18, D5): not a new `/events` route but the snapshot route with
      `waitMs` (`GET /v1/rooms/:id/snapshot?since=<seq>&waitMs=25000`), so a room host from
      before, which ignores it, still works at the old 3 s pace; the answer says `canWait`.
      The room host wakes waiters on every commit (`db.onCommit`, `src/waits.ts`), one wait
      per member (a newer one ends the older), re-checks the session after waiting (removed:
      401, closed: 410). The mod sends apart from receiving: what is typed goes out at once
      while a long-poll waits (`hooks/sync.ts`: `flush` serialized, `refresh` = flush + an
      immediate snapshot), and two answers that cross merge once (`mergeSnapshot` drops an
      older one, adds each entry once). Spike 3: `$.http.fetch` waits 25 s fine
- [x] Presence: online = request within 30 s; pane shows online vs joined (done 2026-10-18.
      The room host stamps every `/v1` request in memory (`createPresence` in `rooms.ts`, no
      migration: it is a fact about the last half minute) and the snapshot's `members[].isOnline`
      says who is here; the pane reads `ben (host, online), ana (successor 1, joined)`. The
      long-poll must renew within 30 s, which `waitMs=25000` does)

Room mode (D21)
- [x] `prompt.submit` hook: in room mode, drop the local turn and post `[login]: text`;
      band shows it; `/room mode on|off`; `/local <prompt>` runs one prompt locally (done
      2026-10-18, `hooks/roommode.ts`: only a prompt the person typed (`composer`, or the
      `bridge`) with no `e.command` is taken; commands, skills, notifications, schedules, peers
      and other plugins pass. The post never waits on the network (a hook has 10 s, and one
      that outlasts them is skipped, which would run the prompt locally): it goes into the
      outbox and `refresh` sends it, so offline it is queued like `/room say`. A failing hook
      fails closed (`.catch` drops with a hint). `/room mode off` is kept in the saved room, so
      a restart keeps it. The band, the pane and the status line say `prompts go to the room`
      or `prompts stay local`. `/local` is a prompt command, `plugin/commands/local.md`: a
      `command.run` hook cannot call `$.prompt.submit` (the engine refuses it), and a prompt
      command reaches the hook with `e.command` set, which passes)
- [x] Images/attachments in room mode: refused with a hint for now (`e.attachments`: "text only",
      names `/local` and `/room mode off`)
- [x] Author always from the session token, never from the text (the room host sets it from
      the token, tested with a body that claims another author; the mod posts the bare text)

Coordinator (host's mod; done 2026-10-18: `protocol/coordinator.ts`, `room-host/src/coordinator.ts`,
`hooks/coordinator.ts`; `room-host/test/coordinator.spec.ts`, `tests/coordinator.test.ts`)
- [x] Room state document (`RoomState`, migration 003 `room_state`): goals, decisions,
      questions, asks (who asked for what), `version`, `coordinatorCursor`, the room's
      `debounceMs`. In every snapshot, so every member mirrors it. Tasks carry `askedBy`
- [x] Countdown in the pane: `coordinator reads in 3 s…` (the snapshot carries `batch: {
      closesInMs } | null`, the time left when the room host answered; the pane counts down
      on its own clock with a redraw each second)
- [x] Batching window: debounce 4 s / cap 12 s, per room, 2–30 s (`/room batch <seconds>`,
      host or admin). D27: the room host holds the coordinator's `GET
      /host/rooms/:id/coordinator` until the window of the unread messages closes, on its
      clock, and reports the same window to members, only while a coordinator reads the room
      (asked in the last 30 s, or holding a batch). A batch: 30 messages or 40 000 characters
- [x] Step: `$.model.complete` on the medium slot (default `claude-sonnet-5-5`), effort
      medium, the fixed instructions as a cached system block, then room state, task map
      (done ones too), members and the batch, every piece of room text fenced (`<`, `>`, `&`
      escaped inside `<room_message seq author>`). The instructions say room text is data;
      merges, rejections, replies and state are its only output. Spike 3: Sonnet merged two
      people's requests into one task, rejected an injection that tried to close the fence,
      merged a third into a claimed task; 3.9 s, the instructions cached
- [x] Output: one JSON object of actions (`createTask`, `mergeIntoTask`, `splitTask`, `reject`,
      `reply`, `updateState`), checked on both sides by `checkActions`: known types, lengths,
      `from` = seqs of the batch (who asked is the messages' authors, never the model's word),
      task ids from the map (no merge into done, split open only), one task action per
      message, asks' logins from the roster. What is dropped is said, with the commit. A reply
      that is no JSON is asked for once more, then the room hears "say again"
- [x] Idempotent commit: applied in one transaction only while `coordinatorCursor` and
      `version` are those read (`409` otherwise: the mod reads again). Model failures retry
      after 5 s, 15 s, then every minute; the room is told once after two, and when it is back
- [x] Merges, splits, rejections, replies and state changes posted as `coordinator` entries
      (`» …` in the pane); the commit's own `read N messages` entry carries usage and what was
      dropped, and stays out of the pane (`quiet`). Coordinator tasks are `createdBy:
      '@coordinator'` and always ask before they run (D23)

Handover (§5; done 2026-10-18: `protocol/handover.ts`, `room-host/src/handover.ts`,
`hooks/handover.ts`; `room-host/test/handover.spec.ts`, `tests/handover.test.ts`)
- [x] Mirror in every mod: the RoomView is it (room, members, tasks, state, status), and its
      log keeps everything the coordinator has not read yet besides the last 200 (1000 at
      most). What a session said lately is kept with its seqs, to be said again after a move
- [x] Successor order + "can host" flag (Q7): each mod reports once per session token
      (`PUT /v1/rooms/:id/me { canHost }`, in memory on the room host like presence): Node 24
      and the room host's files, a provider other than the LAN, the room's secret (and key),
      and a clone of the room's repo. Successors = verified members who can host (not said
      counts as can), in joining order (`successors`); the pane marks `cannot host` and warns
      `if ben leaves, the room closes` when nobody could
- [x] Planned handover: `/room leave` by the host with others in hands the room to the first
      successor who is online (`POST /host/rooms/:id/handover`: a `handover` entry, changes
      refused with 503 so members queue them, the room host up 1.5 s more), or says why nobody
      can and offers `--close`. Quitting Claude Code does the same in `session.end` (400 ms
      for the long-polls to hear it; `/clear` and resume do not)
- [x] Unplanned: a member whose room host has not answered for 30 s (the retry lands on the
      30 s mark) looks for the room in the directory; candidates (successor order, online at
      the last answer) take their turn 15 s apart; taking over claims the directory entry
      with compare-and-set (`claimRoom`: published only while the entry is still the one read),
      so a later candidate finds it changed, stops its room host and follows. An old host
      that answers again before then: nothing moves. Rooms without a repo directory keep
      retrying the old address
- [x] Re-host from mirror: `POST /host/rooms/import` (room id, seqs, roster without sessions,
      tasks, state, status, secret, key) then a `host` entry with `importedUpTo`; the departed
      host's claims go back on the map when they left. Members follow the `handover` entry or
      the directory, check the host proof and join again on their signature (D26; a member
      without a usable key waits for the new host person). A host whose machine slept through
      a takeover finds the room listed elsewhere (directory read every 60 s), stops hosting
      without touching the entry, and follows it. Leaving after a handover leaves the entry
      (only one's own entry is ever removed)
- [x] Last member leaves → close (D18); `/room export` and `/room leave --export` write
      `docs/rooms/<room>.md` (goals, decisions, questions, tasks), not committed (Q6)

Running claimed work (D22, D23; done 2026-10-18: `hooks/runs.ts`, `tests/runs.test.ts`)
- [x] Room bound to repo: `repoUrl`, `baseBranch` (migration 005; the host's mod sets it at
      create from `origin/HEAD`, else the checked-out branch; checked as a branch name on both
      sides, `isBranchName`). A member whose folder is not a clone of the room's repo hears it
      once on joining; runs refuse there
- [x] Approval card on every task from someone else: `Run here` / `Run in worktree` / `Not now`
      (`hooks/pane.tsx`, `hooks/approval.ts`): on a task you claimed that someone else made, or
      with someone else's request merged in (`askedBy`), or the coordinator's. **Not now**
      keeps the task and leaves **Run…** to ask again; the answer lasts while the task is
      yours; the band counts `1 to approve`. Your own task gets **Run here** / **Run in
      worktree** without a card. `runTask` itself refuses a task from others without an
      answer that covers where it runs (here covers the worktree, not the reverse)
- [x] Run = `$.agent.spawn` of Studio's worker (registered on first use, never offered to the
      model, `acceptEdits`, its own instructions: the task is data, nothing leaves the machine,
      no push, no remotes, no credentials) with the task's slice only (title, spec fenced, the
      room's decisions, where it works), the model by the task's difficulty slot. A worktree
      run is the engine's own isolation (spike 3: `.claude/worktrees/agent-<id>` on
      `worktree-agent-<id>`, off the checkout's HEAD, removed when unchanged); `cwd` is not
      honoured by the engine, so no folder of Studio's own. What a run may touch: its edits
      only in its folder, `git push`, remote changes and downloads piped into a shell refused
      (`tool.call` on Edit / Write / NotebookEdit / Bash / PowerShell for its agent id), below
      the person's own permission asks. Its edits are tracked against its folder
- [x] On finish (`turn.complete` with the worker's id): the report posted (`POST
      /v1/rooms/:id/tasks/:taskId/result`, a `task` entry); a worktree run's commits also get
      the task's branch name `studio/<room-slug>/<task-id>` (a second ref; the engine's stays);
      the pane says how it went, the claimer presses **Done** or **Blocked**, a stopped run
      can run again. The worker's context ends with it
- [x] Task branches `studio/<room-slug>/<task-id>` (`protocol/branch.ts` `taskBranch`: ascii
      slug of the room name, the whole task id; both come from another machine and end up as
      git arguments, so only `a-z0-9-` get through. **Clash**: phase 6's per-room branch
      `studio/<room-slug>` cannot exist beside `studio/<room-slug>/…` (git refs are files and
      folders): name that one differently, e.g. `studio-room/<room-slug>`)

Done when: Ben and Ana type related requests within two seconds and the coordinator merges
them into one task and says so; Ana claims and runs it after approving; Ben quits Claude Code
mid-batch, Ana's machine takes over hosting, Cem's mod reconnects, nothing lost or applied twice.

Built and tested 2026-10-18 (72 room host tests, 123 mod tests, `pnpm typecheck`, `pnpm
validate`); spike 3 (§9) ran the long fetch, the coordinator's prompt and the worker on the
real CLI. The two-machine run of the "done when" is left: HANDOFF.md §5.

### Phase 4 — Planning and model slots (spec step 4)

**Model**: Opus for the planner's and the reviewer's instructions and the escalation rule.
Sonnet for model validation, short names, defaults and overrides, worker registration and
the pane. (These slots are the product's models; D24 is about the models that build it.)

- [x] `/studio models` validation (done 2026-10-18: `hooks/models.ts`): one tiny
      `$.model.complete` (16 tokens, 30 s) per newly selected id, in parallel; a refusal warns
      (`model_not_found`, `billing_error`, `authentication_failed`, `invalid_request`, or the
      engine turning the id away) and the choice is kept; a busy or slow API says "could not be
      checked" and is not remembered. Kept in `$.store` (`modelChecks`): usable for 7 days,
      refused for 5 minutes. `/studio models check` asks again about the ones in use. Checked
      on the real CLI: the defaults answer, a made-up id comes back `model not found`
- [x] Short names (`opus`, `sonnet`, `haiku`, `fable`) → full ids (`protocol/models.ts`, any
      case; the full ids, not the engine's aliases, so a slot does not move by itself)
- [x] Room defaults (host or admin) + member overrides (own machine only) (D30: migration
      007, `PUT /v1/rooms/:id/models`, `Room.models`, carried through a handover).
      `/studio models --room hard=opus`, `reset [slot…]` for both; resolution is own → room →
      Studio's (`resolveModels`), shown with where each came from
- [x] Planner (D28; done 2026-10-18: `protocol/planning.ts`, `hooks/runs.ts`, `room-host/src/tasks.ts
      planTask`): the coordinator's `createTask` carries `needsPlan` (never for easy work;
      `/v1/.../tasks` takes it too); claiming and running such a task runs `studio:planner`
      instead of a worker, on the `hard` slot, in the claimer's checkout, after the same card
      (either answer covers a plan). Its type has `tools: Read, Grep, Glob` and 60 turns; its
      reads are held to the checkout (no `..`, no `~`) and away from files that may hold
      secrets (`.env*` but examples, `.git/`, keys, `.ssh` …; a Grep `glob` too): the room
      reads its plan. Its instructions paste the spec's guideline verbatim
      (`DIFFICULTY_GUIDELINE`), ask for 1–8 subtasks of one coherent change each, specs that
      stand alone, 1–6 checkable acceptance checks, no invented requirements, no secrets.
      `checkPlan` on both sides (titles, labels or medium, lengths); `POST
      .../tasks/:id/plan` by the claimer puts the subtasks on the map (`parentId`, `checks`,
      the parent's `createdBy`, `askedBy` + the planner's machine: D23 cards), the parent is
      done. No subtasks: the run stops and the room hears the planner's reason
- [x] Worker agent types per slot (done 2026-10-18: `hooks/runs.ts ensureAgent`):
      `studio:worker-easy|medium|hard` and `studio:worker-worktree-…` (the engine's isolation is
      the type's), plus the planner on the hard slot, each bound to its slot's model. A type is
      registered when a run first needs it and again when its slot's model changed (own choice
      or room default), never offered to the model (`agent.offer`, all seven)
- [x] Reviewer (D29; done 2026-10-18: `hooks/review.ts`, `protocol/planning.ts`): after a
      finished run, one `$.model.complete` with no tools, on the work's slot but never below
      medium, reads the spec, the checks, git's diff from where the run started (a worktree:
      the commit it started at; here: a `git stash create` snapshot, so the person's own
      changes are not the run's), the files the worker wrote that git does not track, the
      commands the worker ran as the engine reported them (its `tool.call`s, output tails),
      and the worker's report marked as a claim; all fenced. `checkReview`: a pass that lists
      an unmet check is a fail; a fail always has a reason. A review that cannot be made
      (no git, the model down) leaves the verdict to the person and counts for nothing
- [x] Escalation (`afterReview`, applied by the room host on `POST .../tasks/:id/review`,
      so every member sees the same): two failed reviews on a slot → up one slot with a
      fresh count; two on hard → `blocked`, the log asks the room what should change, and
      the coordinator sees the review's reasons on the blocked task; a merge into its spec
      starts the count again. A failed review starts the next attempt at once (the card's
      answer still has to cover it), with the reasons as `<previous_review>`; in the checkout
      it builds on the attempt before (same base), in a worktree it starts afresh (the task
      branch name moves to the latest attempt, `branch --force`). Task fields: `slot`,
      `attempts`, `failedReviews`, `review` (migration 006)
- [x] Pane shows slot + attempts per task (done 2026-10-18: `slotText`, `detailLines` in
      `hooks/summary.ts`): `api docs · you · easy→medium · 3 runs` on every open task
      (`to plan (hard)` for one that needs a plan); its open view adds the parent plan, the
      checks, the last review's reasons and `1 of 2 reviews failed on the medium model: one
      more moves it to hard`. The run line says `plan: …` for a plan run
- [x] A plan card (done 2026-10-18): a `needsPlan` task from others asks "plan it here?" with
      **Plan here** / **Not now** (no worktree button: the planner only reads), her own gets
      **Plan here** / **Plan again**; `/room task "<title>" [spec] [--plan]` makes one

Done when: a medium request becomes ≥3 labeled subtasks on the matching models, and a
deliberately failing easy subtask escalates after two failed reviews.

The Opus half is built and tested 2026-10-18 (79 room host tests, 138 mod tests, `pnpm
typecheck`, `pnpm validate`): planner, reviewer, escalation, read by Opus once more for §8
before ticking. That read also closed two holes of phase 3's: a run's edit could reach
`.git/` (a hook or config there runs code at the next git command) or Claude Code's
settings inside the checkout without an ask, and `git config` was not refused; and a `..`
in an edit's path got past the folder check.

The Sonnet half is built and tested the same day (82 room host tests, 158 mod tests, `pnpm
typecheck`, `pnpm validate` with no warnings). What ran on the real CLI: `/studio models
check` (the defaults answer on this account) and a made-up id (`model_not_found`, a warning,
kept).

Finished by Opus 2026-10-18 (82 room host tests, 159 mod tests, `pnpm typecheck`, `pnpm
validate`): the §8 read of `ensureAgent` and `setRoomModels`, then spike 4 (§9), which ran
phase 4 through Studio's own code on the real engine and found three things the kit cannot
show, all fixed:
- **Every run was refused**: `$.agent.spawn`'s `model` takes the Agent tool's aliases only, and
  Studio passed a full id. The spawn now names no model; the type's (registered with the full
  id) decides. The kit's fake spawn refuses a full id too.
- **The holds held nothing, and reviews could not pass**: the engine runs none of a plugin's
  hooks on the calls of an agent the plugin started from its own background work (a hook's
  unawaited continuation, a timer, a button's closure). Studio's edit and command holds, the
  planner's read holds and the record of commands the review reads all live in those hooks;
  in the spike every review failed "the worker never ran `npm test`" and the task climbed to
  hard. Now a run starts only inside one of Studio's hook dispatches: a `ui.press` hook takes
  the pane's run buttons, and `turn.complete` awaits the review and the next attempt (a model
  call is not a hook's own time). A run's prompt reaches its agent only through Studio's
  `agent.spawn` hook (`heldSpawn`): an agent started anywhere else gets a placeholder that
  asks for nothing, and its run stops ("started outside Studio's hooks: press Run again").
- **A worker could leave the holds** (the read): worker types had every tool, so `Agent`,
  `Workflow` or a forked `Skill` could start a loop of its own, `CronCreate` queue a prompt for
  the person's own session, `Monitor` run a command beside the shell's hold. Worker types now
  list their tools (`WORKER_TOOLS`); the engine enforces the list and takes names it lacks.
`setRoomModels` and its route are sound: host or admin only, ids checked on both sides and
again in the mod, refused while handing over, logged for everyone.

Done when, on the real engine (spike 4, one machine, a tiny app): a failing easy task went
easy ×2 → medium ×2 → hard ×2 → blocked, on Sonnet (the person's own choice for easy), Sonnet,
Opus, in 2 min 25 s, every review's reasons naming the unmet check; a dependent subtask failed
once and passed on its next attempt, which read the review. The plan of the medium request
had 2 subtasks (both medium, 5 checks each), not 3: the app is a few dozen lines, so the "≥3"
waits for a real repo. Left for a person at a terminal: the card's buttons starting a held
run (HANDOFF.md §6), a room default reaching a second machine.

### Phase 5 — Limit handoff (spec step 5)

**Model**: Opus for the limit-detection spike (`session.measure`, turn errors) and the
limited host handing coordination over. Sonnet for the WIP note and branch, releasing tasks
and the pane's marks.

- [ ] Detect: `session.measure` `rateLimits[].percentUsed` ≥ 95 %, or `rate_limit` /
      `billing_error` turn errors
- [ ] On limit: worker writes a WIP note, commits and pushes the task branch; tasks released
      with reason `usage limit`; one short room note
- [ ] Pane marks returned tasks ("continues from WIP branch"); member "limited until HH:MM"
- [ ] Next claimer starts from the WIP branch + note
- [ ] **The host hitting a limit**: the coordinator needs model calls — hand coordinating to
      the successor (same handover path, room host may stay where it is)
- [ ] Never auto-switch models (shared usage per account; Fable has its own limit)

Done when: a simulated limit returns tasks with note and branch, another member finishes one;
a limited host hands the coordinator over without the room moving.

### Phase 6 — Multiple rooms (spec step 6)

**Model**: Opus for the cross-room rules in the instructions, `/room send` triage, and who
may read which room's status (private rooms). Sonnet for the room switcher, `/room invite`,
`GET /status`, passing the digest along and per-room branches.

- [ ] Room switcher in the pane; several rooms per room-host process (one process per host
      machine)
- [ ] `/room invite <login>` for private rooms (admins); invitee gets the link
- [ ] Statuses: coordinator keeps `doing / decided / planned / blocked` current
- [ ] Each room host serves `GET /status?since=<version>` (changed keys only, `changedKeys`)
- [ ] Mods read other rooms' statuses via the directory (open rooms; private only if member)
      and pass the digest to the coordinator and workers, never other rooms' logs
- [ ] Cross-room rules in instructions: read the repo first, read **main**, never another
      room's worktree; ask only for intent not in code, or change requests
- [ ] `/room send <room> "<msg>"` → `request` entry at the target room's host; its
      coordinator triages it; the sender's room sees the outcome
- [ ] Per-room branch/worktree `studio/<room-slug>` (not under `studio/<room-slug>/…`: git
      cannot hold both, and phase 3 names task branches that way)

Done when: two rooms on two hosts run in parallel; room A's coordinator sees B's new
`planned` line without asking; a change request from A becomes a task in B.

### Phase 7 — File tracking and overlap threads (spec step 7)

**Model**: Opus for the joint thread (two rooms, two hosts, one thread, results in both
logs). Sonnet for the touch lifecycle, `GET /touches`, the cache, the pre-edit check, the
band prompt and the thread pane.

- [x] Report successful edits (v0)
- [ ] Touch lifecycle: expire 15 min after the last edit, on task done, on branch merge
- [ ] Each room host serves `GET /touches`; mods poll open rooms' touches (10 s) into a cache
- [ ] Pre-edit check in `tool.call` before `next`, against the cache only (no network in
      the hook)
- [ ] On overlap, do not block: band `db-work is also editing seed.sql — [Open joint thread]
      [Ignore]` + `$.ui.notice`; "ignore" remembered per path per session
- [ ] Joint thread hosted by the room host that opened it; scoped to the paths and the two
      rooms; both rooms' members may post; each coordinator posts a short intent summary
- [ ] Thread pane; resolve → result posted to both rooms; closes; rooms never merge

Done when: two rooms editing `seed.sql` both get the prompt; a joint thread opens, resolves,
and the result lands in both room logs.

### Phase 8 — Later (spec step 8)

**Model**: Opus for letting other vendors' agents in (the protocol opened to new clients).
Sonnet for the rest.

- [ ] Single-binary room host (no Node needed on hosts)
- [ ] Named Cloudflare tunnels / Tailscale Funnel for stable addresses
- [ ] Read-only web view of a room, served by the room host
- [ ] Other vendors' agents as additional clients (same protocol)
- [ ] Notifications (`$.ui.notify`) for mentions and returned tasks
- [ ] Channels integration once out of research preview

---

## 8. Cross-cutting work

### Security (every phase)
- **The host is trusted with its rooms' content**: it holds the log and could read or
  rewrite it. Choose hosts for private rooms accordingly; the pane always says who hosts.
- Room host binds `127.0.0.1`; only the address provider exposes it. Quick tunnel and
  Funnel give HTTPS; LAN does not (warn; room key and tokens travel in clear on the LAN).
- A leaked address alone gives nothing: join needs GitHub proof + repo permission
  (+ room key for private rooms), or the host's manual admit.
- Tasks from other members always ask first (D23); worktree preselected.
- Room text and file contents are **data, not instructions**: fenced, with a system line
  saying so; coordinator output is validated actions; no Bash from room text without the
  claimer's approval. Red-team cases in tests.
- Tokens hashed on the host; secrets never in `$.state`; no message bodies in logs.
- Directory entries hold no secrets; private rooms' entries are encrypted.

### Testing
- Room host: `node:test` against `:memory:`; one test per route and permission rule; the
  CLI as a real child process; signatures from real `ssh-keygen` (fixtures) plus a live
  round trip where `ssh-keygen` is on PATH.
- Mod: `claude plugin test`; answer `http.fetch` and `process.run` from the test's hooks
  (fake room host, fake `git`/`gh`/`ssh-keygen`); panes on `terminal` and `desktop`.
  Engine calls a test answers return `{ value }`; `mock.clock(on).settle()` waits for
  unawaited work.
- Contract: `tests/contract.test.ts` keeps the state contract and wire types in step.
- End-to-end: per-phase checklist with two machines on different networks.

### Cost and context
- Coordinator: fixed instructions first, `cache: true`; room state compact plain text;
  statuses plain text (spec).
- Workers get only their slice; context discarded after each task.
- Log coordinator token use (`usage`) in the commit's log entry `data`.

### Surfaces
- Panes draw in the terminal and the Desktop app's Code tab, not VS Code's chat panel:
  command output and toasts must carry the essentials there.
- Unasked panes wait for 144 columns; the band covers narrow terminals.
- **Hot reload kills the room host** (a module reload ends its child process). While
  developing the mod, run the room host by hand (`pnpm dev`) and point the mod at it.

### Which model builds it (D24)

The model Claude Code runs with while building Studio (`/model opus`, `/model sonnet`), not
the model slots Studio gives its own agents (phase 4).

**Opus** when a mistake is expensive or hard to see:
- Security: identity, signatures, tokens, permission checks, encryption; anything that
  decides who gets in, or what runs on someone's machine
- Distributed state: handover, idempotent commits, races, retries across machines
- The agents' instructions: coordinator, planner, reviewer, cross-room rules. Their quality
  is the product's
- First use of an early-access mod API surface (`$.agent.spawn`, `session.measure`,
  `prompt.submit`, streams): reading the types and testing what the engine really does
- Refactors that change the wire contract or many files at once
- Bugs that resisted two attempts (flaky tests, cross-platform, network)

**Sonnet** when the work follows something already in the repo:
- Routes, commands, pane and band UI shaped like existing ones
- Tests modeled on existing files (`plugin/room-host/test/api.spec.ts`, `plugin/tests/room.test.ts`)
- Docs, PLAN ticks, install hints, config, packaging; mechanical renames and moves

**Split tasks**: Opus writes the risky core and its tests first; Sonnet builds the commands,
UI and docs around it in a later session. §10 marks these *Opus → Sonnet*.

**Escalate**: Sonnet fails the same task twice (tests stay red, or a review finds a real
bug) → Opus, handed what was tried. The rule Studio itself uses for its workers (phase 4).

**Review gate**: before an item that touches §8 Security is ticked, an Opus session reads
its diff, whichever model wrote it.

So far: phase 0, spikes 1 and 2, the room-host refactor and phase 1's Opus items (join
handshake, hosting core, directory) were built with Opus, and the security-touching parts
read once more by Opus before ticking (§8 review gate). Phase 1's Sonnet items (host check,
`/room list`, invite and pane wording, `/room attach`) were built with Sonnet; the two that
touch untrusted input or the host key were then read by Opus, and fixed where it found
something (§7). Phase 2 and phase 3's Sonnet items were built with Sonnet; phase 3's Opus
items (long-poll, coordinator, handover, running claimed work) with Opus, which read the
security-touching parts once more before ticking: that read moved the token out of address
changes (D26) and made `runTask` check the approval itself. Phase 4's Opus items (planner,
reviewer, escalation) with Opus, read once more: that read kept runs out of `.git/` and
Claude Code's settings, refused `git config`, and turned the reviewer's git off its
file-system monitor. The gate's read of the Sonnet half (`ensureAgent`, `setRoomModels`) and
spike 4 (Opus) gave the worker types a tool list and found that the holds never ran on the
real engine for agents Studio started from background work: runs now start inside Studio's
hook dispatches, and an agent started elsewhere gets no task.

### Mod API churn
- The mod API is early access. Re-run `pnpm validate` and `pnpm test` on every Claude Code
  update; read the regenerated `plugin/.claude-plugin/types/claude-code/index.d.ts`.

---

## 9. Risks and spikes

| Risk | Impact | Spike / mitigation | When |
|---|---|---|---|
| **Reachability**: no Tailscale, no cloudflared, different networks | Teammates cannot connect | Host check before create; clear install hint for cloudflared (host only) | Phase 1 |
| Quick tunnels are testing-grade: random URL per start, no SLA, 200 in-flight cap, no SSE | Flaky rooms, URL changes on every restart | Long-poll only; re-publish address on change; recommend Tailscale for daily use; named tunnels later | Phase 1, 8 |
| A new tunnel name looked up too early is cached as "no such name" (60 s; a home router held it for the whole 47 s test) | The host or a joiner cannot reach a fresh room for a minute | Spike 2's order: registered → DNS over HTTPS has the name → only then publish the link; joiners retry 90 s | Phase 1 |
| SSH-signature identity across OSes and agents | Join flow fails for some people | Spike 1 done on Windows (below); macOS signed and verified in the two-machine run; Linux untried; manual admit fallback | Phase 1 |
| Tailscale's serve/funnel CLI differs from what `providers.ts` runs (untried on a tailnet) | `/room create` on a Tailscale machine falls through to cloudflared, or LAN | Fall-through is built in; check `tailscale serve --http=<port>` in the two-machine run | Phase 1 |
| A quick tunnel restart gives a new address | Members are cut off until they join again | One restart, new link logged and published; members following the directory needs host identity (phase 3) | Phase 1, 3 |
| `gh` missing on the host | No repo permission check | Manual admit fallback | Phase 1 |
| Room host dies with the module (session end, hot reload) | Host quitting Claude Code ends hosting | Planned handover in `session.end`; detached-host spike | Phase 1, 3 |
| Handover races (two candidates re-host) | Split room | Directory push as tie-break; clients follow the directory | Phase 3 |
| Node 24 not on a would-be host | Fewer possible hosts | Host check; single binary later | Phase 1, 8 |
| Host machine sleeps | Room stalls until handover | 30 s detection, staggered re-host | Phase 3 |
| `$.agent.spawn` + worktree isolation details | Workers can't be isolated as planned | Spike 3 (below): `cwd` is ignored; the engine's `isolation: 'worktree'` works and is used; the task's branch is a second ref | Done; recheck `cwd` on Claude Code updates |
| Handover split: a quick tunnel restart slower than 30 s | A candidate takes over while the old host still runs | Compare-and-set claim; each host reads the directory every 60 s and stands down when the room is listed elsewhere with a valid proof; what was said in the room that lost is not carried back | Two-machine run |
| The engine's re-entry rule: a plugin's hooks never see the agents its background code starts | A run's holds and the review's evidence silently gone | Spike 4: runs start inside Studio's hook dispatches; the run's prompt only through Studio's `agent.spawn` hook, a placeholder otherwise; recheck on Claude Code updates (`claude --debug`: `tool.call nested in studio#…`, not `skipped: re-entry`) | Done; every engine update |
| Limit detection precision | Tasks stuck with a limited member | Spike: log `session.measure` + turn errors near a limit | Phase 5 |
| Prompt injection through the room (or a malicious host) | Team-wide compromise | Fencing, validated actions, approval cards, worktrees | Phase 3, every phase |
| Coordinator quality | People stop trusting merges | Visible merges, easy objection, tune with real transcripts | Phase 3 |

### Spike 1 — SSH-signature identity (done 2026-10-17, Windows 11)

- **Signing works as planned.** `ssh-keygen -Y sign -n studio-join -f <key>.pub`, message on
  standard input, writes the armored signature to standard output (`$.process.run` takes
  `stdin`: no temp files). Tried with Windows' own OpenSSH 9.5 and Git for Windows' OpenSSH
  10.2, keys ed25519, RSA 3072, ECDSA P-256/384/521: each build verifies the other's
  signatures. Windows' output has CRLF lines.
- **Windows' ssh-keygen hangs** on a key with a passphrase when there is no terminal (Git's
  fails at once). So every call gets a 10 s timeout, and the mod picks the key first:
  listed by `ssh-add -L` → use it; else `ssh-keygen -y -P "" -f <key>` exits 0 (no
  passphrase) → use it; else tell the person to `ssh-add` it.
- **Agents are per OpenSSH build**: Windows' agent service (off by default; turning it on
  needs admin) and Git's socket agent do not see each other. The mod sticks to the
  `ssh-keygen` / `ssh-add` first on PATH.
- **The host verifies in Node** (`room-host/src/sshsig.ts`, node:crypto), so hosts need no
  OpenSSH. Security keys (`sk-*`) are not supported → manual admit.
- `github.com/<login>.keys`: plain `type base64` lines, no comments, 404 for an unknown
  login. Signing keys are only in the REST API (`users/<login>/ssh_signing_keys`, 60
  requests an hour without a token): read best effort.
- Not covered here: macOS/Linux (same OpenSSH code as Git's build), Windows' agent service,
  the `gh` permission check (`gh` not installed on this machine).

### Spike 2 — Hosting from the mod (done 2026-10-17, Windows 11, Claude Code 2.1.301, cloudflared 2026.10.1)

A throwaway mod (`/spike-host`, run with `claude -p --plugin-dir`) did what `/room create`
will do. Timings from one run:

| Step | At |
|---|---|
| `$.process.spawn(['node', 'server/src/index.ts', '--port', '0'])` (now `room-host/`) prints its ready line | 0.7 s |
| `$.http.fetch('http://127.0.0.1:<port>/health')` from the mod | 200 |
| `cloudflared tunnel --url …` prints the `trycloudflare.com` address | 5.8 s |
| `Registered tunnel connection` in cloudflared's output | 6.8 s |
| DNS over HTTPS (`cloudflare-dns.com/dns-query`) has the name | 17.8 s |
| First request through the public address | 200, first try |
| Round trips through the tunnel (from the same machine) | 82–192 ms |

- **Ending the loop ends the child**: after both loops ended, the port refused connections,
  the public address answered 502, and no `cloudflared` process was left.
- **Claude Code exiting ends the child**, cleanly (`claude -p` returning) and when
  force-killed (`Stop-Process -Force`): the room host went with it (Windows; probably a
  job object). macOS/Linux not tried: hence the orphan guard in phase 1.
- **DNS is the trap**: the first two runs looked the name up right after cloudflared printed
  it, got "no such name", and kept getting it from the router's cache for 40+ s, while
  1.1.1.1 had the name 10 s later. `trycloudflare.com`'s SOA minimum is 60 s. Hence: wait
  for registration, poll DNS over HTTPS, and only then look the name up or send the link.
- `$.process.spawn`'s stream: read output with `for await`; `stream.return()` from
  elsewhere ends the loop and the child. Spawned without `input`, the child's standard
  input is closed from the start.
- Git Bash rewrites `claude -p "/cmd"` into a path (`C:/Program Files/Git/cmd`): run
  slash commands headless from PowerShell, or with `MSYS_NO_PATHCONV=1`.

### Spike 3 — Phase 3's engine calls (done 2026-10-18, Windows 11, Claude Code 2.1.302)

A throwaway mod run with `claude -p --plugin-dir` (from PowerShell):

- **`$.http.fetch` waits**: a request a local server held 25 s came back 200 after 25 020 ms,
  inside a command hook. The long-poll's 25 s is safe.
- **`$.model.complete` with the coordinator's prompt** on `claude-sonnet-5-5`: one task from
  two people's messages (`from: [11, 12]`), the injection that tried to close
  `</room_message>` and claim to be ben rejected with a reason, a third person's request
  merged into a claimed task, asks recorded; 3.9 s, 1 508 tokens of instructions written to
  the cache. `checkActions` dropped nothing.
- **`$.agent.register` / `$.agent.spawn`**: register answers `{ agent: '<plugin>:<name>' }`;
  spawn answers `{ model, agentId }` and the agent runs in the background; `$.agent.list()`
  lists it with `spawnedBy: '<plugin>'`; its end is a `turn.complete` carrying its
  `agentId` and its report, and `claude -p` waits for it. **`cwd` is not honoured**: the
  worker's environment and shell were the session's folder, with the path in both forms.
- **The engine's `isolation: 'worktree'`** (an agent type's field) puts the worker in
  `<repo>/.claude/worktrees/agent-<agentId>` on branch `worktree-agent-<agentId>`, its shell
  really there; the engine refused a `cd` back into the shared checkout before git; unchanged,
  the worktree and branch were gone after the run.
- **A `tool.call` hook can rewrite a subagent's call** (`next({ ...e, command })`): a
  PowerShell call of the worker's ran where the rewrite said. Not used: the isolation does it.
- On this machine auto mode's safety check answered "no verdict" for the worker's edits in
  `-p` mode, so the worker wrote nothing: the person's own permission mode governs a run's
  edits; `acceptEdits` on the agent type did not get past it. To see interactively.

### Spike 4 — Phase 4 on the real engine (done 2026-10-18, Windows 11, Claude Code 2.1.302)

A copy of `plugin/` with a driver module, run with `claude -p --plugin-dir` (PowerShell,
`--permission-mode acceptEdits --allowedTools PowerShell Bash`) against a room host started
by hand, in a throwaway repo (a settings page in a few dozen lines, `npm test`, a `.env`
with a canary value). The driver called Studio's own `runTask` where the card's button
would; two small probe mods pinned down the engine's rules.

- **`$.agent.spawn({ model })` takes `sonnet | opus | haiku | fable` only**: a full id is an
  `InputValidationError`. Without `model` the agent runs on its type's (`$.agent.register`
  takes full ids): the spawn answers `{ model: 'claude-haiku-5-5', agentId }`.
- **Re-registering a type mid-session works**: the next spawn runs on the new model.
- **`tools` holds**: a worker of `WORKER_TOOLS` sees Read, Edit, Write, Glob, Grep, Bash,
  PowerShell, ToolSearch, and NotebookEdit, WebFetch, WebSearch deferred; asked to use Agent,
  CronCreate, Monitor, Skill or Workflow it has none of them. A name the build lacks (`LSP`,
  `NoSuchTool`) is accepted and ignored.
- **The re-entry rule**: a `$` call is raised under the frames of the hook dispatch it was made
  in; once that hook has returned, the plugin's code runs in no frame, and every event of an
  agent spawned there (its tool calls, `tool.check`, `classic.PreToolUse`) skips the plugin's
  whole module (`--debug`: `hooks module studio@inline tool.call skipped: re-entry (the
  plugin's own code raised it; origin studio)`). Spawned inside a dispatch, even one whose
  hook returned a moment later, the agent's calls are `nested in studio#<n>` and every other
  hook of the plugin sees them, for as long as the agent runs (one probe held a call made
  16 s later). Spawned from a timer, 5 s or 12 s into a hook's background work (waits in
  flight or not): unseen. `turn.complete` is the engine's and always reaches the plugin.
- **The planner** (Opus, `Read, Grep, Glob`): 60–80 s; its last message was the bare JSON
  object each time; it read the code, refused to read `.env` on its own instructions (the
  canary is in no plan), and planned only what `<other_tasks>` did not cover (a room still
  holding an earlier plan's subtasks got 2, then 1 new ones). On the clean room: 2 subtasks.
- **Reviews**: with the holds seeing the worker, the reviewer read `npm test`'s output; a
  subtask that depended on its siblings failed once ("the base lacks darkMode … the 3 new
  tests fail") and passed on the attempt that read that review. A task done only "once `git
  push origin HEAD` has succeeded" climbed easy → medium → hard → blocked in 2 min 25 s; each
  worker refused the push on its own instructions, so Studio's push hold had nothing to do.
- Not seen: a press of the pane's buttons (no terminal in `-p`; the kit's press runs the same
  `ui.press` chain), the person's permission asks in an interactive session.

---

## 10. Next tasks

Phases 1–4 are built (§7). What stands between them and done is two-machine runs
([HANDOFF.md](HANDOFF.md) has the scripts: §2 phase 1, §3 phase 2, §5 phase 3). Anything that
touches who gets in or what runs where (`room-host/src/joins.ts`, `access.ts`, `handover.ts`,
`rooms.ts admit`, `plugin/hooks/identity.ts`, `joining.ts`, `handover.ts`, `runs.ts`,
`protocol/seal.ts`, `protocol/coordinator.ts` and the coordinator's instructions) goes to
Opus (§8 review gate).

1. **Phase 3 two-machine run** — *Sonnet*, three people ideally (HANDOFF.md §5): the "done
   when" of phase 3, plus a run on a real task with the approval card, the worker's
   permission asks in an interactive session (spike 3 saw only `-p`), a planned and an
   unplanned handover, and a tunnel restart members follow. Opus if a failure resists two
   attempts, and for anything in the coordinator's instructions.
2. **Phase 4 at a terminal** — *Sonnet*, one machine (HANDOFF.md §6). Spike 4 (§9) ran the
   planner, reviews, escalation and a re-registered slot type on the real engine, and the
   Opus read is done. Left: the card's **Plan here** / **Run in worktree** starting a run
   Studio holds (not "started outside Studio's hooks"), the worker's permission asks, a room
   default on a second machine, a plan of ≥3 subtasks on a real repo. Opus if a press does
   say "started outside Studio's hooks" (the `ui.press` hook in `hooks/pane.tsx` is then not
   the dispatch the engine runs the closure in), or if the instructions need changing (D24).
3. **Phase 1's two-machine rows** — *Sonnet* (it needs two machines and the people at them). Main rows
   passed 2026-10-17 (§7, under phase 1's "done when"): cloudflared from a home NAT, a signed
   join from macOS, tasks, messages, the claim race, `touching`, leaving and cleanup, the
   tunnel's restart and loss. Left, with the second person back: HANDOFF.md rows 9 (a
   read-only collaborator refused: on a personal repo, remove them as a collaborator, since
   GitHub offers no read role there and a public repo gives everyone read), 11 (private room)
   and 10 (Let in). Without a tailnet or Linux machine: `--via tailscale` / `--via funnel`,
   a Linux signature. Opus if a failure resists two attempts.

Known gaps, by design for now: an entry is left when the host's session ends without a
handover (next create drops it); a marketplace install has no `pnpm install` (D25:
`/room create` names the npm line; a bundled room host is phase 8); `MARKETPLACE`
(`hooks/invite.ts`) and the README's install line name the test repo until publishing;
messages queued offline (and prompts room mode sent) are lost with a reload of the mod; a
prompt dropped for the room may come back into the prompt box (unseen); approval answers
are not kept across a restart; a file written through `Bash` is not tracked (only the file
tools are observed); on Windows a lost room's data folder stays until the next `/room create`
sweeps it.

Phase 3's own: following a room to a new address means joining again, so a member without a
usable SSH key is let in by hand each time, a quick tunnel restart included (D26); a member
who left still holds the room's secret until someone is removed; a planned handover's
successor and the unplanned candidates use their mirror, so what reached the old host in its
last moments but no member is gone (each member's own messages are said again); a room
without a repo directory cannot be followed (the successor hosts and prints its link); a
worktree run starts from the claimer's HEAD, not the room's base branch (the worker is told
which the room uses), and its worktree stays under `.claude/worktrees/` once it changed
something, for the person to merge and remove; the coordinator's `asks` cannot name a task it
creates in the same batch; the coordinator is the host's model calls, so a host on a usage
limit stalls it (phase 5).

Phase 4's own: a failed review starts the next attempt by itself, so work labeled easy can
run six times (twice per slot) before it blocks; each attempt pays on the claimer's account.
What the engine saw a worker run is in memory, so a reload of the mod mid-run leaves the
review git's diff alone, and a review under way when the mod reloads leaves its run on
`reviewing` (runTask lets it run again). A file the worker made through Bash, not Write, is
in neither the diff nor the new files. Subtasks that build on each other say so in their
spec only (`After "<title>":`); nothing orders their claims. Each failed worktree attempt
leaves its worktree under `.claude/worktrees/`. The planner's Grep searches files git
ignores only as the engine's Grep does; a secret file the repo tracks is held back by its
name alone.

Phase 4's slots: the account check says whether a model answers, not whether it keeps
answering (a limit or credits can run out later); a room default reaches a member with
their next poll, and a run already started keeps its model; a member who inherits a room's
default is not asked about it (only a model they select), so a default their account cannot
use shows up when a run fails to start or at `/studio models check`; a mod from before
`/studio models` kept all three slots in its file, which now read as three own choices; a
reload of the mod forgets which types are registered (they are defined again at the next run).

Sources used for tunnel limits: [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/),
[Tailscale plans](https://tailscale.com/plans/).
