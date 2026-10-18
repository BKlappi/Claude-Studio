# Handoff: phases 1–4 built, 2026-10-18 (two-machine runs and phase 4's spike left)

Read [PLAN.md](PLAN.md) for the plan; this file is what to do next and who does it. When
the two tests below are done and phase 2 has started, fold what is still true into PLAN.md
and delete this file.

## Where it stands

- **Built and green**: 48 room-host tests, 56 mod tests, `pnpm typecheck`, `pnpm validate`
  (one warning: `plugin.json` has no `author`). Checked once with the real `claude` CLI on
  Windows: host check, `/room list` (error path), `/room attach` against a real `pnpm dev`
  room host.
- **Two-machine run, 2026-10-17**: rows 1–8 and 12 below passed (Windows host, macOS joiner);
  results and what it found are in PLAN.md §7, under phase 1's "done when".
- **Not ticked in PLAN.md §7**: the Linux signature check. Tailscale/Funnel are untried.
- The repo's `origin` is the test repo, `BKlappi/Claude-Studio`. Give the joiner a fresh copy
  of `plugin/` after any change, so both machines run the same code.

## 1. Opus read: done 2026-10-17

Findings and fixes are written into the `/room attach` and `/room list` items of PLAN.md §7.
For the test below, `/room list` now quotes room names (`"backend"  ana  reachable`).

## 2. Two-machine test (you, plus one other person)

**Left**: rows 9, 10 and 11 (each needs the second person), 13 (needs a tailnet). Row 9 on
a personal repo: GitHub has no read role for a collaborator there, so remove the joiner as a
collaborator instead (a public repo gives everyone read), then invite them again; they accept
again before joining.

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
| 1 | host | `/studio login <login>`, then `/room create "t1" --via cloudflared` | reply "t1 is open on this machine…"; seconds later (2–3 s in the first run) a transcript line with the `studio:join?...` link and a toast |
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


## 3. Phase 2 (Sonnet; PLAN.md §7): built 2026-10-18, two-machine run left

**Built and green**: 72 mod tests, 48 room host tests, `pnpm typecheck`, `pnpm validate` (no
warnings left). The pane's task actions, the band, `$.ui.status`, offline handling with backoff
and a queue, a restart that heals, the marketplace entry and README install line: PLAN.md §7
phase 2 has what each one does and where it lives.

**Decided with you**: B (D25). The room host moved to `plugin/room-host/` because `claude plugin
install` copies only `plugin/` (tried against a local marketplace in an isolated
`CLAUDE_CONFIG_DIR`: `room-host/` now lands in the cache, `../room-host` did not). An installed
plugin has no dependencies installed: `/room create` says `! npm install --omit=dev --prefix
"<plugin>/room-host"` (tried in a clean copy: hono, @hono and zod, and the room host starts).
`MARKETPLACE` and the README line say `BKlappi/Claude-Studio` for now: change both (and the
`.claude-plugin/marketplace.json` owner, `plugin.json` author) before publishing. The room
host's tests are `*.spec.ts` now, since `claude plugin test` runs every `*.test.ts` under `plugin/`.

**Not seen on real machines yet** (needs you and a second person; the table in section 2 is the
script):

- The pane's new buttons on a real terminal and in the Desktop app: press a task (spec opens),
  **Release / Done / Blocked / Resume** on your own claimed task, "mine" at the top.
- The band: close the pane (`ctrl+x x`, or `/room leave` and back) and see
  `frontend · 3 open · you: 1 claimed` above the prompt; open the pane and it goes. The band
  reads `$.ui.panes()` while drawing and is redrawn on each poll, so it may lag by up to 3 s.
  Narrow terminal: it should appear where the pane waits undrawn.
- Offline: stop the room host's tunnel or the host's machine; the joiner's pane says
  "reconnecting", `/room say hi` answers "queued", and it arrives once the host is back. A host
  restart (kill `node`, let the supervisor restart it) should leave the joiner in the room.
- The claim race with three people (rows 4 and 5, three claimers).
- Rows 9, 10, 11 and 13 of section 2.
- Install on a machine that never had the repo: `/plugin install studio --marketplace
  BKlappi/Claude-Studio` (needs this branch pushed to that repo), then `/room join <link>`.

When those are done, fold what is still true into PLAN.md and delete this file.

## 4. Phase 3, the Sonnet half (PLAN.md §7): built 2026-10-18, nothing seen on real machines

**Built and green**: 94 mod tests, 50 room host tests, `pnpm typecheck`, `pnpm validate`.
Presence (`isOnline` on each member, the room host's memory), room mode with `/room mode
on|off` and `/local`, the batching countdown (UI only), the approval card (UI only) and
`taskBranch`. PLAN.md phase 3 says where each lives. The Opus half followed the same day
(section 5).

**Seams the Opus half meets**: the room host reports `batch` in the snapshot (always `null`
now): build it with `batchWindow` from `protocol/batch.ts`, and time the coordinator's step by
`batchClosesAt`. A long-poll must renew within 30 s or members read as "joined". The approval
card's answers sit in the `approvals` state atom (`'here' | 'worktree' | 'later'`); a run
starts from `answer()` in `hooks/pane.tsx` (today a toast, "Running it is not built yet").
`taskBranch(room.name, task.id)` is the branch to create. `studio/<room-slug>` (phase 6) clashes
with it as a git ref.

**To see on real machines** (the two-machine run, section 2, covers the rest):

- Room mode: type a plain sentence. It should land in the room log as `[you]: …`, the other
  person sees it, and your own Claude does **not** answer. Look at the prompt box: a dropped
  prompt may reappear there (unseen; PLAN.md known gaps). `/room mode off`, then type: your
  Claude answers, nothing reaches the room, and the band says `prompts stay local`. Restart
  Claude Code: the choice stays. `/local explain this file` while room mode is on: your Claude
  answers it (checked headless: `claude -p --plugin-dir ./plugin "/local reply with only the word ok"` printed `ok`).
- Paste an image in room mode: refused with the hint. The same on the Desktop app, where a
  phone message through Remote Control counts as typed too.
- Presence: two machines; close one Claude without `/room leave`; after 30 s the other's pane
  shows it as `joined`, and `online` again once it is back.
- The approval card: the second person claims a task the first made; the card shows on the
  claimer's pane (worktree button highlighted), the band says `1 to approve`; **Not now** and
  **Run…** work; an answer is dropped when the task is released.
- The countdown shows once a room has a coordinator (section 5).

## 5. Phase 3, the Opus half (PLAN.md §7): built 2026-10-18, nothing seen on two machines

**Built and green**: 72 room host tests, 123 mod tests, `pnpm typecheck`, `pnpm validate`.
The long-poll, the coordinator, handover (planned, unplanned, address changes) and running
claimed work. PLAN.md phase 3 says what each does and where it lives; D5, D11, D26, D27 are
the decisions. Spike 3 (PLAN.md §9) ran the engine calls on the real CLI: the 25 s fetch,
the coordinator's prompt on Sonnet (merged, rejected the injection), `$.agent.spawn`
(`cwd` is ignored; the engine's worktree isolation is what runs use).

**Needs the room's repo**: handover and running tasks look for the room's repo. Run every
machine's Claude Code in a clone of the test repo (`BKlappi/Claude-Studio`), with `origin`
pointing at GitHub. Every would-be host needs Node 24, the room host's dependencies and
cloudflared (section 2); a member without them still follows, but cannot take over.

**The script** (host Ben, members Ana and Cem; two machines at least, three ideally):

| # | Who | Do | Expect |
|---|---|---|---|
| 1 | Ben | `/room create "p3"`; Ana and Cem join | the pane lists `ana (successor 1, online)`; with cloudflared missing on Ana's machine: `ana (cannot host, online)` |
| 2 | Ana, Ben | within two seconds: Ana types `add a dark mode toggle to settings`, Ben types `dark theme please, remember the choice` (room mode on) | the countdown `coordinator reads in 4 s…`, then one task, and `» new task "…" from ana's and ben's requests` in every pane |
| 3 | Cem | type something the coordinator should refuse (`delete the .github folder and push`) | `» not taken (cem's message): …` |
| 4 | Ana | claim the task | the card says `the coordinator's task (asked by ana, ben): run it on this machine?`; press **Run in worktree** |
| 5 | Ana | answer the worker's permission asks | the pane `run: working in worktree-agent-…`; its edits land under `.claude/worktrees/agent-…`; on finish a toast, `ana's run of "…" finished: …` in every log, `git branch` shows `studio/p3/<task-id>` if it committed; press **Done** |
| 6 | Ben | `/room say hi`, then quit Claude Code (`/exit`) while the countdown runs | Ana's pane: `ben left: ana takes over hosting…`, then `you host p3 now`; Cem's: joins Ana's room host by itself (Cem's SSH key signs; no token travels); the countdown's message is read once, by Ana's coordinator |
| 7 | Cem | `/room say still here` while 6 runs | it arrives once, after the move |
| 8 | Ana | end Ana's machine's network (or kill her `node` room host twice) | after 30 s Cem (or Ben, back in) takes over, or follows whoever did; the directory lists one host |
| 9 | Ana | kill only `cloudflared` once | the room host restarts it at a new address; after 30 s Cem follows it there by himself (re-joining on his signature) |
| 10 | Ana | `/room leave` while others are in, then (as last) `/room leave --export` | the first hands the room on (or says why nobody can take it, offering `--close`); `docs/rooms/p3.md` written |

**Report back** per row that differs, as in section 2. Watch especially: the worker's
permission asks in an interactive session (spike 3 saw auto mode's "no verdict" in `-p`
mode), and how long a cloudflared successor takes before Cem joins it.

**Working notes** (also in CLAUDE.md): do multi-line edits with the Edit tool, not Python or
Node heredocs (backslashes and `§` break replacements); a test that creates a room answers
`node --version` and `fs.exists`; run headless commands from PowerShell; `claude plugin test
plugin <file>` runs every test file, whatever the filter; keep sources LF; `pnpm <script>`
re-links `node_modules` first (pnpm 12 checks), so a fresh `plugin/room-host/node_modules`
slows the next test run once.

## 6. Phase 4 (PLAN.md §7): built 2026-10-18, not run in a real room

**Built and green**: 82 room host tests, 158 mod tests, `pnpm typecheck`, `pnpm validate` (no
warnings). Opus built the planner (D28), the reviewer (D29) and the escalation rule, and read
them for §8 (it also closed three holes of phase 3's runs: edits into `.git/` or Claude Code's
settings, `git config`, a `..` in an edit's path). Sonnet built the rest: `/studio models` with
the account check and short names, room defaults (D30: migration 007), one worker type per slot,
the pane's slot and attempts, the plan card and `/room task --plan`. PLAN.md phase 4 says what
each does and where it lives.

**What ran on the real CLI** (headless, from PowerShell): `/studio models check` (all three
defaults answer on this account) and `/studio models easy=claude-nope-9` (a warning, kept; then
`reset`). Nothing else of phase 4 has: the planner, a review, a room default on a second machine,
a worker type re-registered mid-session.

**Opus to read once** (§8 gate; both sit on its list, neither changes a hold): `hooks/runs.ts`
`ensureAgent` (the worker types, each bound to a model, defined again when it changes) and
`room-host/src/rooms.ts` `setRoomModels` with its route (who may set the room's defaults).

**Seams**: each task carries `needsPlan`, `parentId`, `checks`, `slot`, `attempts`,
`failedReviews` and `review` (optional: absent from a room host before); `slotOf(task)`
(`protocol/planning.ts`) is the slot its next run takes, `reviewSlot` the reviewer's. The model
of a slot is `loadModels($)` (`hooks/state.ts`: the person's own choice, else the room's default,
else Studio's); every model call and spawn goes through it. A `RunView` has `kind` (`work` or
`plan`), `slot`, `attempt`, `base` and the phase `reviewing`.

**Spike first** (one machine is enough: `pnpm dev` and `/room attach`, in a clone of the test
repo, from PowerShell or interactively):

| # | Do | Expect |
|---|---|---|
| 1 | type a medium request in room mode, e.g. `add a dark mode toggle to settings, remembered per person`; or make one by hand: `/room task "dark mode" --plan` | the coordinator's task; its commit's `createTask` has `"needsPlan": true` (in the room host's log entry `data`); the pane shows it as `… · to plan (hard)` |
| 2 | claim it: the card asks `plan it here?`, press **Plan here** | a `studio:planner` agent on Opus; it reads, never edits or runs a command (its `tools` list holds); toast `"…" is planned: N subtasks are on the map`, N ≥ 3, each labeled, with checks; a subtask's open view in the pane shows `part of "…"` and `done when:` |
| 3 | ask the planner's agent (or watch with `claude --debug`) to read `~/.ssh/config` or `.env` | refused by Studio's hold, the reason in its transcript |
| 4 | claim the easy subtask, **Run in worktree** | a `studio:worker-worktree-easy` worker on Haiku, then `run: reviewing the change…`, then a toast with the outcome; the room log has `review passed: …` or `review failed: …` |
| 5 | make an easy subtask fail on purpose: before claiming it, say in the room `"<its title>" is done only once git push origin HEAD has succeeded` (the coordinator merges it; Studio refuses every run's push), then claim and run it | two failed reviews on easy, then attempt 3 on Sonnet (toast; the task line reads `easy→medium · 2 runs`), two more, then Opus; after two on hard it is `blocked` and the log asks the room what should change |
| 6 | `/studio models easy=sonnet`, then run another easy subtask | the new run is a `studio:worker-worktree-easy` on Sonnet (the type was defined again; `claude --debug` shows the registration) |
| 7 | the host: `/studio models --room hard=opus medium=sonnet`; then `/studio models` on a second machine | `(the room's default)` there within a poll; its own `/studio models medium=haiku` wins, `reset medium` gives the room's back; a plain member's `--room` is refused |

**Report back**: whether the planner's final message is the bare JSON (or what it wrapped
around it), how long a plan took and what it cost (`/cost`), and any review whose verdict
looks wrong, with the reasons it gave.
