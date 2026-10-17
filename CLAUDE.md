# Studio — working notes for Claude

- Spec: `studio-mod-spec.md`. Plan and phase status: `PLAN.md` (tick boxes as work lands).
- Before starting a PLAN item, read its phase's **Model** line (D24). An Opus item in a
  Sonnet session: say so and ask before starting. Sonnet failing an item twice: suggest Opus.
- Two parts, no build step: `plugin/` (Claude Code mod) and `room-host/` (Node 24 runs `.ts`
  directly; the host's mod spawns it, PLAN.md D14/D15).
- `plugin/protocol/` is the single source of wire types; the room host imports it by relative
  path with `.ts` extensions; the mod imports it without extensions. Keep it dependency-free
  and use `import type` between its files.
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

## Commands

- `pnpm test` (`test:host`, `test:plugin`) · `pnpm validate` · `pnpm typecheck` · `pnpm dev` · `pnpm studio`
- Room host code: erasable TypeScript only (no enums, no parameter properties). Schema
  changes are a new `room-host/src/db/migrations/NNN-*.sql`, never an edit to an old one.
- A mod command headless: `claude -p --plugin-dir <dir> "/cmd"` from PowerShell. Git Bash
  rewrites `"/cmd"` into a Windows path (or set `MSYS_NO_PATHCONV=1`).
- `claude plugin test` gives the test the engine's `$` (event-shaped calls, no `$.store`),
  not the mod's: test mod helpers that take `$` through a hook or command, or keep their
  logic pure. Test hooks answering engine calls return `{ value }`; see `tests/room.test.ts`.
  `tests/fakes.ts` fakes the network, commands, children and a git remote: a test hook's
  `{ deny: 'ENOTFOUND …' }` makes the call reject with that text; a fake `process.spawn` is an
  async generator that returns `{ value: { code, signal } }`. In the kit `stream.return()`
  waits behind a pending read (the real engine kills at once): fake children exit themselves.
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
