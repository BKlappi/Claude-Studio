# Handoff: end of phase 1 build, 2026-10-17

Read [PLAN.md](PLAN.md) for the plan; this file is what to do next and who does it. When
the two tests below are done and phase 2 has started, fold what is still true into PLAN.md
and delete this file.

## Where it stands

- **Built and green**: 48 room-host tests, 56 mod tests, `pnpm typecheck`, `pnpm validate`
  (one warning: `plugin.json` has no `author`). Checked once with the real `claude` CLI on
  Windows: host check, `/room list` (error path), `/room attach` against a real `pnpm dev`
  room host.
- **Never run**: a room across two machines or networks. Everything network-shaped was
  tested against fakes, except the Spike 1 and 2 results in PLAN.md §9.
- **Not ticked in PLAN.md §7**: the macOS/Linux signature check, the two-machine run.
  Tailscale/Funnel are untried. (`/room list` and `/room attach` are ticked after the Opus read.)
- **No git commits yet**, no remote. Commit before the test so both machines run the same code.

## 1. Opus read: done 2026-10-17

Findings and fixes are written into the `/room attach` and `/room list` items of PLAN.md §7.
For the test below, `/room list` now quotes room names (`"backend"  ana  reachable`).

## 2. Two-machine test (you, plus one other person)

Different networks is the point (home NAT to elsewhere). Same network only tests the LAN
provider.

**Both**: Claude Code 2.1.287 or newer, git, an SSH key listed at `github.com/<login>.keys`
(in `ssh-agent`, or without a passphrase). Both are collaborators with **write** access on one
test repo and run Claude Code in a clone of it. The plugin is not published yet, so each
machine needs a copy of `plugin/` from this repo (the joiner needs nothing else), started with
`claude --plugin-dir <path>/plugin`.

**Host only**: Node 24, this repo with `pnpm install` done, cloudflared
(`winget install --id Cloudflare.cloudflared`), `gh auth login`.

**Joiner only**: nothing more. Ideally macOS or Linux (the signature check is untested there).

| # | Who | Do | Expect |
|---|---|---|---|
| 1 | host | `/studio login <login>`, then `/room create "t1" --via cloudflared` | reply "t1 is open on this machine…"; 20–60 s later a transcript line with the `studio:join?...` link and a toast |
| 2 | joiner | `/studio login <login>`, `/room join <link>` | "Joined t1, hosted by …"; pane shows both logins, no "(unverified)" |
| 3 | either | `/room list` | the other's room, `reachable`, with a `/room join` line |
| 4 | host | `/room task "a"`, `/room say hi` | joiner sees both within ~3 s |
| 5 | both | press **Claim** on the same task at the same moment | one claims it, the other gets a "Claim failed" toast |
| 6 | joiner | have Claude edit a file in the clone | host's `/studio status` shows it under `touching` |
| 7 | host | `/room leave` while the joiner is in | refused (the host leaves last) |
| 8 | joiner | `/room leave`, then host `/room leave` | `~/.claude/studio/room-hosts/` empty, no `node` or `cloudflared` left, `git ls-remote origin studio-rooms` shows no entry for the room |
| 9 | host | create again; set the joiner's repo access to **read**, then they join | refused with the reason; set it back to write afterwards |
| 10 | host | create again; a joiner with no usable key joins | host sees "wants in (unverified)" with **Let in** / **Refuse**; Let in works |
| 11 | host | `/room create "p" --private`; joiner joins with the link, then with the link's `key=` removed | the first joins, the second says why not; `rooms.json` holds no name for it |
| 12 | host | end `cloudflared` once, then again | first: restarts, new link logged and published; second: "room lost", entry removed |
| 13 | both, if a tailnet exists | `--via tailscale`, then `--via funnel` | untried: report exactly what `tailscale` says |

Clean up after: `git push origin --delete studio-rooms` on the test repo.

**Report back** per row that differs: OS, Claude Code version, provider, seconds from create to
link, and the message verbatim. For a failure, run with `claude --debug` and send the lines
starting `Studio:`. Two failed attempts at the same thing go to Opus (PLAN.md §8).

## 3. Phase 2 (Sonnet, `/model sonnet`; PLAN.md §7)

**Decide first, before "Ship"**: how the room host reaches an installed plugin. The mod finds it
at `<plugin>/../room-host`. A marketplace entry with `source: "./plugin"` looks like it copies
only that folder into `~/.claude/plugins/cache/`: the caveman plugin (`source: "./"`) has its
whole repo there, the expo plugin only its own files. Not tried with Studio. If so, an installed
Studio has no room host, and no `pnpm install` has run for it either. Options:

- **A.** Make the repo root the plugin (`source: "./"`): `plugin.json`, `hooks/` and the rest move
  up a level. Big move, room host still needs its dependencies.
- **B.** Move `room-host/` into `plugin/room-host/` (its import of `plugin/protocol` gets shorter),
  and have the host check offer the `npm install`/`pnpm install` it needs on first `/room create`.
- **C.** B plus a bundled room host (one file, no dependencies), built in a release step. Breaks
  "no build step" (D1), but it is what a host without pnpm needs; PLAN.md phase 8 lists a
  single binary for later.

Recommend B, C if hosts without pnpm matter now. Test it: `claude plugin install` from a local
marketplace and look at what lands in the cache. Needs from you: the GitHub `<owner>/<repo>` for
Studio, then set `MARKETPLACE` in `plugin/hooks/invite.ts`.

**Items** (all Sonnet, none touches §8 Security, so no Opus read; pointers):

- Pane: "mine" first, press a task to expand its spec, **Release / Done / Blocked** for the
  claimer: `hooks/pane.tsx`. The client has `releaseTask`; add the state change
  (`POST /v1/rooms/:id/tasks/:taskId/state`, body `{ state, version }`) to `client()` in
  `hooks/api.ts`. Mark the host and possible successors.
- Band when the pane is closed or narrow (`frontend · 3 open · you: 1 claimed`): `ui.render` on
  `{ component: 'AbovePrompt' }`, plus `$.ui.status` for room and connection state. Grep
  `plugin/.claude-plugin/types/claude-code/index.d.ts` before guessing props.
- Offline: `hooks/sync.ts` polls on a fixed `clock.every(3000)`; backoff 3 s to 30 s needs a
  `clock.after` chain. File reports already re-queue on failure; `/room say` and `/room task`
  do not queue yet. Show "reconnecting".
- Host-side restart heals without user action: the room host restarts on the same port, data
  and key (`hooks/hosting.ts`), so member tokens should survive. Prove it with a test where the
  member's mod keeps polling across the restart.
- Tests: pane on `terminal` and `desktop` (see `PANE` and `ui.mount` in `tests/hosting.test.ts`),
  commands against a fake room host (`tests/room.test.ts`, `tests/attach.test.ts`).
- Ship: `.claude-plugin/marketplace.json` (copy the shape of the caveman one: `$schema`, `name`,
  `owner`, `plugins[{ name, source, description, category }]`), README install line, add `author`
  to `plugin.json`.
- Manual checklist (two machines): the same table as above, plus the claim race with three people.

**Working notes** (also in CLAUDE.md): do multi-line edits with the Edit tool, not Python or
Node heredocs (backslashes and `§` break replacements); a test that creates a room answers
`node --version` and `fs.exists`; run headless commands from PowerShell; `claude plugin test
plugin <file>` runs every test file, whatever the filter; keep sources LF.
