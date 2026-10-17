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
into the **room host** (`room-host/`), the process a member's mod starts on their own machine.

**Server** (as built in phase 0; now `room-host/`, see phase 1)
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
that touch untrusted input or the host key had their §8 Opus read the same day (§7). What is
left is the two-machine run (§10).

Not there yet: the two-machine run; shared input, the coordinator, Studio-started agent work,
model slots in use, limit handoff, cross-room features, overlap threads.

---

## 2. Decisions

| # | Decision | Why | Revisit when |
|---|---|---|---|
| D1 | **Node 24, TypeScript run directly**, no build step, pnpm workspace | Fewest moving parts | Hosts without Node become common (see D20) |
| D2 | **Hono** for HTTP | Tiny, typed, `app.request()` tests | — |
| D3 | **SQLite on the host's machine**, in memory by default, or one file under `--data` (survives a room-host restart); **deleted when the room host's last room closes** | Rooms are ephemeral (D18) | — |
| D4 | **Room log is the room's source of truth while it is open**; tasks/status are projections written in the same transaction | Rebuild a coordinator after handover; idempotent commits | — |
| D5 | **Polling now, long-poll next**; no SSE, no WebSocket | A mod has only `$.http.fetch`; quick tunnels do not carry SSE | Mod API gains streaming fetch |
| D7 | **`plugin/protocol/` is the shared package**; room host imports it by relative path | A mod may import only files inside its folder | — |
| D8 | **Mod state rules**: atoms only in `hooks/state.ts`; `$`-taking helpers are `function` declarations; contract `types/index.d.ts` self-contained, checked against protocol | `claude plugin validate` requires it | Validator changes |
| D10 | **Coordinator = model calls from the host's mod** (`$.model.complete`), not the host's main conversation | Keeps the host's session clean; cheap; structured actions we validate | Never needs a server now: it already runs where the room runs |
| D11 | **Workers = subagents** (`$.agent.spawn`) with a per-slot model; worktree isolation offered | Spec: per-subagent model; security | — |
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

Nothing blocks phase 1. These can wait until their phase.

- **Q6. Keep anything when a room closes?** Recommended: nothing by default; an opt-in
  `/room close --export` that writes a short summary (decisions, done tasks) to
  `docs/rooms/<name>.md` in the repo. (Phase 3.)
- **Q7. Who may host?** Recommended: anyone whose machine passes the host check (Node 24 +
  an address provider). The pane shows who could take over, and warns when the host is
  the only one ("if Ben leaves, the room closes"). (Phase 3.)

Answered: Q8 (directory branch) = yes, now D17.

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

Room host (`room-host/`, done 2026-10-17)
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
- [ ] Members follow an address change by themselves (today they join again with the new
      link). Needs the host to prove it is the same room host before a member sends its
      token there (a directory entry is writable by anyone with push access): phase 3,
      with handover
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
- [ ] macOS + Linux: sign, verify against the Windows host (two-machine run)
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

### Phase 2 — Mod v0 complete (spec step 2)

**Model**: Sonnet for all of it: UI, offline handling, tests and shipping follow what is
already there.

- [ ] Manual checklist (two machines): create, invite, join, add task, claim race (one
      winner; loser gets a toast)
- [ ] Pane: "mine" first; press a task to expand its spec; **Release**, **Done**, **Blocked**
      for the claimer; host and possible successors marked
- [ ] Band when the pane is closed or narrow: `frontend · 3 open · you: 1 claimed`
- [ ] `$.ui.status`: room + connection state
- [ ] Offline handling: backoff 3 s → 30 s, "reconnecting", queued file reports and messages
- [ ] Tests: pane on `terminal` and `desktop` with signed-in fake state; commands against a
      fake room host (answer `http.fetch` from the test's own hooks)
- [ ] Ship: `.claude-plugin/marketplace.json`, README install line, GitHub repo; then set
      `MARKETPLACE` (`<owner>/<repo>`) in `hooks/invite.ts` so `/room invite` carries the
      install line

Done when: two members see the same task map within ~3 s, the claim race always has one
winner, and a host-side restart heals without user action.

### Phase 3 — One shared room (spec step 3)

**Model**: the Opus phase. Opus for the coordinator (instructions, action schema,
validation, idempotent commit), all of handover, the long-poll on the room host, and running
claimed work (the `$.agent.spawn` + worktree spike, fencing, what a run may touch). Sonnet
for presence, the room-mode hook and `/local`, the batching countdown, the approval card's
UI and task branch names.

Push and presence
- [ ] `GET /rooms/:id/events?since=<seq>&waitMs=25000` long-poll (one in-flight request
      per member: well under a quick tunnel's 200 cap)
- [ ] Presence: online = request within 30 s; pane shows online vs joined

Room mode (D21)
- [ ] `prompt.submit` hook: in room mode, drop the local turn and post `[login]: text`;
      band shows it; `/room mode on|off`; `/local <prompt>` runs one prompt locally
- [ ] Images/attachments in room mode: refused with a hint for now
- [ ] Author always from the session token, never from the text

Coordinator (host's mod)
- [ ] Room state document: goals, decisions, open questions, who asked for what,
      `version`, `coordinatorCursor`
- [ ] Batching window: debounce 4 s / cap 12 s, per room, countdown in the pane
- [ ] Step: `$.model.complete` with fixed instructions (cached) + room state + task map +
      the batch, room text fenced as data (`<room_message author="…">…</room_message>`)
- [ ] Output: validated JSON actions (`createTask`, `mergeIntoTask`, `splitTask`, `reject`,
      `reply`, `updateState`); invalid ones dropped and logged
- [ ] Idempotent commit (`upToSeq` + `baseVersion` compare-and-set)
- [ ] Merges, splits, rejections posted visibly; objections are just the next messages

Handover (§5)
- [ ] Mirror in every mod: state doc, task map, members, log since cursor
- [ ] Successor order + "can host" flag per member (Q7)
- [ ] Planned handover on `/room leave` and `session.end`
- [ ] Unplanned handover: 30 s detection, staggered candidates, directory push as tie-break
- [ ] Re-host from mirror; clients follow `handover` entries or the directory
- [ ] Last member leaves → close; optional `--export` (Q6)

Running claimed work (D22, D23)
- [ ] Room bound to repo: `repoUrl`, `baseBranch`; mod checks `origin` on join
- [ ] Approval card on every task from someone else: `Run here` / `Run in worktree` / `Not now`
- [ ] Run = `$.agent.spawn` with the task's slice only (title, spec, relevant decisions,
      likely files); worktree isolation when chosen
- [ ] On finish: short result posted; claimer confirms **Done** or **Blocked** + note;
      working context discarded
- [ ] Task branches `studio/<room-slug>/<task-id>`

Done when: Ben and Ana type related requests within two seconds and the coordinator merges
them into one task and says so; Ana claims and runs it after approving; Ben quits Claude Code
mid-batch, Ana's machine takes over hosting, Cem's mod reconnects, nothing lost or applied twice.

### Phase 4 — Planning and model slots (spec step 4)

**Model**: Opus for the planner's and the reviewer's instructions and the escalation rule.
Sonnet for model validation, short names, defaults and overrides, worker registration and
the pane. (These slots are the product's models; D24 is about the models that build it.)

- [ ] `/studio models` validation: one tiny `$.model.complete` per new id; warn if the
      account cannot use it (e.g. Fable needs usage credits on Pro); cache
- [ ] Short names (`opus`, `sonnet`, `haiku`, `fable`) → full ids
- [ ] Room defaults (room creator) + member overrides (own machine only)
- [ ] Planner: coordinator flags `needsPlan` → planner subagent on the `hard` slot with
      read-only tools; returns subtasks labeled easy/medium/hard with the spec's guideline
      pasted verbatim, each with acceptance checks
- [ ] Worker agent types per slot (`studio:worker-easy|medium|hard`), re-registered on change
- [ ] Reviewer agent: diff vs spec + tests → pass/fail + reasons
- [ ] Two failed reviews → up one slot; hard fails twice → `blocked`, ask the room
- [ ] Pane shows slot + attempts per task

Done when: a medium request becomes ≥3 labeled subtasks on the matching models, and a
deliberately failing easy subtask escalates after two failed reviews.

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
- [ ] Per-room branch/worktree `studio/<room-slug>`

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
- Tests modeled on existing files (`room-host/test/api.test.ts`, `plugin/tests/room.test.ts`)
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
something (§7).

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
| SSH-signature identity across OSes and agents | Join flow fails for some people | Spike 1 done on Windows (below); macOS/Linux in the two-machine run; manual admit fallback | Phase 1 |
| Tailscale's serve/funnel CLI differs from what `providers.ts` runs (untried on a tailnet) | `/room create` on a Tailscale machine falls through to cloudflared, or LAN | Fall-through is built in; check `tailscale serve --http=<port>` in the two-machine run | Phase 1 |
| A quick tunnel restart gives a new address | Members are cut off until they join again | One restart, new link logged and published; members following the directory needs host identity (phase 3) | Phase 1, 3 |
| `gh` missing on the host | No repo permission check | Manual admit fallback | Phase 1 |
| Room host dies with the module (session end, hot reload) | Host quitting Claude Code ends hosting | Planned handover in `session.end`; detached-host spike | Phase 1, 3 |
| Handover races (two candidates re-host) | Split room | Directory push as tie-break; clients follow the directory | Phase 3 |
| Node 24 not on a would-be host | Fewer possible hosts | Host check; single binary later | Phase 1, 8 |
| Host machine sleeps | Room stalls until handover | 30 s detection, staggered re-host | Phase 3 |
| `$.agent.spawn` + worktree isolation details | Workers can't be isolated as planned | Spike: per-call model + worktree; confirm cwd, branch, cleanup | Before phase 3 work runs |
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

---

## 10. Next tasks

Phase 1's Opus and Sonnet items are built and read (§7); one thing stands between it and done
([HANDOFF.md](HANDOFF.md) has the test script and the phase 2 brief). Anything that touches who
gets in (`room-host/src/joins.ts`, `access.ts`, `rooms.ts admit`, `plugin/hooks/identity.ts`,
`joining.ts`, `protocol/seal.ts`) goes to Opus (§8 review gate).

1. ~~**Opus read of `/room list` and `/room attach`**~~ — done 2026-10-17; findings and fixes
   are in the two items of §7.
2. **Two-machine run** — *Sonnet* (it needs two machines and the people at them): phase 1's
   "done when", plus: a signed join from macOS or Linux; `--via tailscale` and `--via funnel`
   on a real tailnet; cloudflared from a home NAT (install it first: it is not on this
   machine); a read-only collaborator refused; both leave → process gone, entry gone,
   `~/.claude/studio/room-hosts/` empty; `/room list` on the second machine shows the first's
   room as reachable and its `/room join` line joins it. Opus if a failure resists two attempts.
   Already checked here, on Windows with the real CLI (not fakes): the host check names a
   missing cloudflared / Tailscale; `/room list` reads the directory error of a repo without
   `origin`; `/room attach` creates, re-enters and refuses as the tests say.

Known gaps, by design for now: members do not follow an address change (§7 phase 1, needs
host identity, phase 3); an entry is left when the host's session ends (next create drops
it); installed from a marketplace, the mod finds the room host at `<plugin>/../room-host`
only if the repo is installed whole (the host check now says so; phase 2's shipping decides
the layout); `/room invite` has no install line until phase 2 sets `MARKETPLACE`
(`hooks/invite.ts`).

Sources used for tunnel limits: [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/),
[Tailscale plans](https://tailscale.com/plans/).
