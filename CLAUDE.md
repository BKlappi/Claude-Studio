# Studio — working notes for Claude

- Spec: `studio-mod-spec.md`. Plan and phase status: `PLAN.md` (tick boxes as work lands).
- Before starting a PLAN item, read its phase's **Model** line (D24). An Opus item in a
  Sonnet session: say so and ask before starting. Sonnet failing an item twice: suggest Opus.
- Two parts, no build step: `plugin/` (Claude Code mod) and `plugin/room-host/` (Node 24 runs
  `.ts` directly; the host's mod spawns it, PLAN.md D14/D15). The room host sits inside
  `plugin/` because installing a plugin copies only that folder; its tests are `*.spec.ts`,
  since `claude plugin test` runs every `*.test.ts` under `plugin/`.
- `plugin/protocol/` is the single source of wire types; the room host imports it by relative
  path with `.ts` extensions (`../../protocol/`); the mod imports it without extensions. Keep
  it dependency-free and use `import type` between its files.
- `plugin/types/index.d.ts` must stay self-contained (validator rule); `tests/contract.test.ts`
  type-checks it against `protocol/types.ts`.

## Mod rules learned from `claude plugin validate`

- Every `$.state` read/write lives in `plugin/hooks/state.ts`, where the atoms are defined.
- Functions that receive `$` across files must be `function` declarations, not arrow consts.
- No `setTimeout`, no `console`, no Node: timers are `$.clock`, network is `$.http.fetch`.
- Secrets (the auth token) go in `$.store`, never `$.state` (any plugin reads state).
- Observer `tool.call` hooks call `next(e)` first and end with `.catch(($, e, next) => next(e))`.
- The API is early access: the authority is the `claude-code.d.ts` Claude Code writes into
  `plugin/.claude-plugin/types/` on load. Grep it before guessing a prop or method.
- Learned on load, not from the validator: `hooks.json` names one module, and an event takes
  one matcher-less hook per plugin (a second fails the whole module). `$.agent.spawn`'s
  `model` takes the Agent tool's aliases only (`sonnet` …; a full id is refused): a run's
  model is its agent type's, set by `$.agent.register` (full ids work there).

## Commands

- `pnpm test` (`test:host`, `test:plugin`) · `pnpm validate` · `pnpm typecheck` · `pnpm dev` · `pnpm studio`
- Room host code: erasable TypeScript only (no enums, no parameter properties). Schema
  changes are a new `plugin/room-host/src/db/migrations/NNN-*.sql`, never an edit to an old one.
- A mod command headless: `claude -p --plugin-dir <dir> "/cmd"` from PowerShell. Git Bash
  rewrites `"/cmd"` into a Windows path (or set `MSYS_NO_PATHCONV=1`).
- `claude plugin test` gives the test the engine's `$` (event-shaped calls, no `$.store`),
  not the mod's: test mod helpers that take `$` through a hook or command, or keep their
  logic pure. Test hooks answering engine calls return `{ value }`; see `tests/room.test.ts`.
  `tests/fakes.ts` fakes the network, commands, children and a git remote: a test hook's
  `{ deny: 'ENOTFOUND …' }` makes the call reject with that text; a fake `process.spawn` is an
  async generator that returns `{ value: { code, signal } }`. In the kit `stream.return()`
  waits behind a pending read (the real engine kills at once): fake children exit themselves.
- A member session against a fake room host (pane, band, polling, offline): `memberWorld(on)`
  in `tests/fakes.ts` wires the store, clock, UI and a stateful `fakeRoomHost` whose `isDown`,
  `proxy` (a tunnel's 502) and `tokens` the test flips; see `tests/pane.test.ts` and
  `tests/offline.test.ts`. A hook that passes the band (`next(e)`) needs an engine drawing
  beneath it in the kit (`memberWorld` has one); `$.ui.status` needs a hook too (`fakeStatus`).
- Polling backs off 3 s → 30 s on `clock.after` (`pollDelay` in `hooks/sync.ts`). What the person
  types while the room host is down waits in `post()`'s outbox (in memory, 50 at most).
- The long-poll is the snapshot route with `waitMs` (D5); the room host wakes waiters on
  `db.onCommit` (`src/waits.ts`). `fakeRoomHost`'s `canWait` holds such a request on the test's
  clock until the log grows; off, it answers at once like an old room host (3 s pace).
  Sending is apart from receiving: `startSync` pauses, `forgetRoom` alone empties the outbox.
- Room host tests that need the batching window's time: `t.mock.timers.enable({ apis:
  ['setTimeout', 'Date'] })` and settle with `setImmediate` (`test/coordinator.spec.ts`).
- The coordinator's test world answers `model.complete` with `{ value: { isAnswered, text, usage }
  }` (`tests/coordinator.test.ts`). Its actions are checked by `checkActions`
  (`protocol/coordinator.ts`) on both sides; who asked is the messages' authors, never the model's.
- Handover (D26): a session token never goes to a new address; members check the host proof
  (`protocol/seal.ts`) and join again on their signature. The room's secret lives in `Saved`
  (`$.store`). `tests/handover.test.ts` has a following member, a candidate and a host world;
  a `session.end` hook that sleeps needs the call started, the clock advanced, then awaited.
- `$.agent.spawn`'s `cwd` is ignored (Claude Code 2.1.302, PLAN.md §9 spike 3): worktree runs use
  the agent type's `isolation: 'worktree'` (`.claude/worktrees/agent-<id>`, branch
  `worktree-agent-<id>`). In the kit a test's `agent.spawn` hook returns `{ model }` only (core
  alone sets `agentId`; its `e` is the Agent tool's input): runs.ts then finds the agent in
  `$.agent.list()`, which a test answers with `{ value: [...] }`; `turn.complete` needs a bottom
  hook returning `{ text }` (`tests/runs.test.ts`).
- Room mode (`hooks/roommode.ts`): the `prompt.submit` hook never waits on the network (`enqueue`
  into the outbox, `refresh` sends; a hook that outlasts its 10 s is skipped and the prompt would
  run locally) and fails closed in `.catch`. A test fires it with `$.prompt.submit({ text, origin:
  { kind: 'composer' }, wait: false })`; `memberWorld(...).entered` lists what got past it to the
  person's own Claude. A `command.run` hook cannot call `$.prompt.submit` (the engine refuses it):
  `/local` is the prompt command `plugin/commands/local.md`, which reaches `prompt.submit` with
  `e.command` set. Where prompts go is `Saved.roomMode` (on unless false), shown by `modeText`.
- Presence is in memory on the room host (`createPresence`, `isOnline` on each member); the
  coordinator's batching window is `protocol/batch.ts`, reported as the snapshot's `batch` (null
  until the coordinator lands). A test sets `host.batch`, `host.members[i].isOnline` on the fake.
- `ui.invalidate('ui.render')` redraws the pane at once (the countdown ticks with it).
- Edit multi-line code with the Edit tool: a Python heredoc turns `\'` and `\n` in the new text
  into a bare quote or a real newline.
- `/room create` runs the host check first (`hooks/hostcheck.ts`): a test that creates a room
  answers `node --version` (`v24.x`) from its `process.run` and `fs.exists` with `true`
  (`machine()` in `tests/hosting.test.ts` shows both, and `missing`/`node`/`cloudflared` options).
- A hook has 10 s of its own time, and `$.clock` waits count: anything that waits (DNS, a
  ticket, a restart) runs as background work started by the hook, through `inBackground`
  (`hooks/processes.ts`). An unhandled rejection fails the test file and outlives an
  unloaded module.
- The mod's `crypto.subtle` has `digest` only (no AES, no HMAC): `protocol/seal.ts` builds
  on SHA-256.
- Python on Windows writes CRLF unless told `newline=''`; keep sources LF.
- Protocol files share types only, never values (the two sides spell imports differently):
  `protocol/planning.ts` repeats `fence` and the text cleaner of `protocol/coordinator.ts`.
- Phase 4 (`protocol/planning.ts`): the escalation rule `afterReview` runs on the room host;
  `fakeRoomHost` applies the same one and records `plans` and `reviews`. `tests/runs.test.ts`
  `machine()` answers the reviewer's `model.complete` (`reviews: [...]`, `'down'`), the
  review's git reads (Studio spells them `git -c core.fsmonitor=false …`; the fake strips it)
  and `fs`. A test fires a run's tool call with `toolCall($, { tool, …, agentId: 'a1' })`:
  `$.tool.call`'s typed input is too deep for tsc there. Grep with `$'\r'` in Git Bash counts
  every line: check line endings with `git ls-files --eol` or Python.
- Model slots (phase 4, D30): a slot's model is `loadModels($)` (`hooks/state.ts`: own choice,
  else `room.models`, else `DEFAULT_MODELS`); never read the store for it directly. Short names
  and the id shape are `protocol/models.ts`. A model call is outside a hook's 10 s (it takes
  its own `timeoutMs`). `/studio models` asks the account with `$.model.complete` and keeps the
  answer in `$.store` (`modelChecks`); `tests/models.test.ts` `account(on, { id: 'billing' | … })`
  answers it, and `fakeRoomHost` has `PUT .../models` (`modelSets`, `hasModelDefaults`). A
  run's agent type is `studio:worker[-worktree]-<slot>` (`workerType`), defined by
  `ensureAgent` when its model changed: `machine()` in `tests/runs.test.ts` lists `registered`.
- Docs and plan text: write them with the Edit or Write tool. A backtick inside a
  double-quoted `node -e` or heredoc in Bash runs as a command.
