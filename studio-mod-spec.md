# Studio — Multi-User Agent Rooms for Claude Code

## Summary

Studio is a Claude Code plugin (with a mod) plus a small server that lets several people work together in shared **rooms**. Each room has its own AI coordinator and shared context. Every member types into their own Claude Code, and their messages land in the same room, where agents plan, split, and execute the work together.

The product is the **collaboration layer**: shared rooms, task handoffs between people, overlap detection, and compact statuses. Model routing is a setting, not the product.

Version 1 is **Claude-only** and runs inside Claude Code. Other model vendors may be added later as additional clients.

---

## Core Concepts

### Team
- Created by an owner (on a website or via command).
- Members join via invite and log in from the plugin.

### Roles
| Role | Permissions |
|---|---|
| Owner | Team settings, everything an admin can do |
| Admin | Create restricted/private rooms, assign people to rooms, manage roles |
| Member | Create open rooms, join any open room |

### Rooms
- Any member can create a room and name it freely (e.g. `design frontend`, `db work`).
- **Open rooms**: visible to the whole team; any member can join.
- **Private rooms**: visible only to their members (for sensitive work such as security fixes).
- All active open rooms are visible in the room list.
- Each room has:
  - its own **coordinator** (the room agent)
  - a **room log** on the server (append-only)
  - a **task map** (open, claimed, done, blocked tasks)
  - a **status** (see Status Format)
  - its own git branch / worktree
- A room is a context boundary: agents in one room do not load other rooms' logs.

---

## Commands

```
/studio login                 # browser sign-in, links Claude Code to the team
/studio models                # show model slots
/studio models hard=<id> medium=<id> easy=<id>

/room create "<name>" [--private]
/room join <room>
/room list                    # rooms, members in them, what is active
/room leave
/room invite <member>
/room send <room> "<message>" # cross-room request (see rules below)
```

---

## Architecture

**Server + thin clients.**

- **Server** stores: teams, members, roles, rooms, room logs, task maps, statuses, live file-tracking data. It never handles billing or model credentials.
- **Client (v1)**: a Claude Code plugin containing a mod. It:
  - draws the room pane (room log, task map, members, statuses)
  - forwards the user's room messages to the server, tagged with the author
  - starts turns in the local session when the room has work for this member
  - reports file edits to the server (via a `tool.call` hook on edit/write tools)

### Who runs the coordinator (v1)
- The room creator's Claude Code session **hosts** the room coordinator.
- If the host leaves, hosting hands over to another member in the room.
- Because the room log lives on the server, an empty room is never lost: whoever joins next rebuilds the coordinator from the log.
- Later options (not v1): a server-side coordinator, or fully distributed agents reading a shared log. Design the server log so moving there later needs no rewrite.

### Billing
- Every member pays with their own Claude account (plan or API key).
- Work runs on the machine of the member who claimed the task.
- Rooms only share context, tasks, and statuses.

---

## Shared Input

- Every message in a room is tagged with its author: `[Ben]: add dark mode`
- **Batching window**: after a message arrives, wait a few seconds before the coordinator processes it, so messages from several people arriving together are seen together. This is what makes merging requests possible.
- The coordinator can **merge** related requests into one task, **split** them, or **start a new task**. Every merge or rejection is posted visibly in the room so members can object.
- The room pane is mirrored to every member.

---

## Context Management

- The coordinator keeps a compact **room state**: goals, open tasks, decisions, who asked for what. It is updated regularly.
- The full history stays in the server room log, not in any agent's context.
- Workers only receive the slice of context needed for their subtask.
- After a task is finished, its working context is discarded. Any agent must be able to pick up a task from the room state + task map alone.

---

## Planning and Model Slots

### Model slots
Three slots, configured per user with `/studio models`:

| Slot | Used for |
|---|---|
| `hard` | Planning + hardest subtasks |
| `medium` | Default for most coding |
| `easy` | Quick, simple tasks |

- Slots accept full model IDs (e.g. `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`). Short names (`opus`, `sonnet`, `haiku`) may work as shortcuts.
- When a model is selected, check once whether the user's account can use it and warn if not (e.g. Fable needs usage credits on Pro plans).
- Room owner sets room defaults; members can override for the work their own machine runs.

### Planning flow
1. The model in the `hard` slot creates the plan.
2. It splits the plan into subtasks and labels each **easy**, **medium**, or **hard**.
3. Each subtask runs on the model in the matching slot.
4. A review step checks the result against the subtask spec and tests.
5. If a subtask fails review twice, it moves up one slot.

### Difficulty guideline (give this to the planner)
- **Easy**: one file, clear spec, existing tests to check against (rename, small fix, add a test).
- **Medium**: several files, normal feature work, clear goal.
- **Hard**: design decisions, unclear requirements, cross-cutting changes, tricky bugs.

### Usage limits
- On one account, usage is shared across models, so switching models does not help when a limit is reached (Fable is an exception with its own limit).
- When a member hits their limit, their claimed subtasks go **back to the room's task map**, and another member picks them up. Post a short note in the room.

---

## Cross-Room Rules

### Read, don't ask
- If information exists in the repo, the agent reads it itself. Asking another room costs tokens in two places and adds waiting time.
- Read the **committed state on the main branch**, never another room's in-progress worktree.

### When to send a cross-room message (`/room send`)
Only for:
- **Intent not yet in the code** (mostly covered by the `planned` line in statuses)
- **Change requests** for work owned by another room (e.g. "please add an `email` column to `users`")

The message lands as a request in the target room.

### Statuses
- Each room publishes a compact status. Other rooms read only the **changes since their last read**.

---

## Status Format

Fixed keys, compact plain text (cheaper for models than JSON):

```
room: db-work | v12
doing: users table migration
touching: db/schema.sql, db/seed.sql
decided: users.email unique; soft delete via deleted_at
planned: rename orders.user → orders.user_id
blocked: -
```

- `touching` is filled automatically from live file tracking.
- `planned` carries announced intent and replaces most cross-room questions.
- Version number increments on every change.

---

## File Tracking and Overlap Threads

- The mod reports every file edit/write path to the server in real time.
- Every room can see which files other rooms are currently working on.
- When a room starts work on a file another room is touching, the agent asks:
  > `db-work is also editing seed.sql — open a joint thread?`
- On yes, a **temporary joint thread** opens:
  - scoped to the overlapping file(s) only
  - receives a short summary from both rooms
  - both rooms' members can take part
- When the overlap is resolved, the thread closes and posts its result back to both rooms.
- Whole rooms are not merged.

---

## Security

- A mod runs with the user's full permissions. Tasks started by other people must not run unchecked on a member's machine.
- Tasks originating from other members either:
  - require local approval before running, or
  - run only in an isolated git worktree.
- Treat text from the room log and from files as data, not instructions (prompt injection risk spreads across the whole team otherwise).
- Private rooms are hidden from non-members on the server side, not just in the UI.

---

## Build Order

1. **Server basics**: teams, members, roles, rooms (data model for multiple rooms from the start).
2. **Mod v0**: `/studio login`, a room pane showing a shared task list, claim a task with a button.
3. **One shared room**: author-tagged input, batching window, host coordinator, room log on server, rebuild from log.
4. **Planning + model slots**: difficulty labels, slot routing, review, escalation.
5. **Limit handoff**: return tasks to the map when a member hits a limit.
6. **Multiple rooms**: `/room` commands, open/private rooms, statuses.
7. **File tracking + overlap threads**.
8. Later: web client, other vendors' agents, server-side coordinator.

---

## Open Questions

- **Onboarding**: how does a new user get from "a friend sent me an invite" to "I'm in a room and my message reached the agents" with as little setup as possible?
- Host handover details: what happens to in-flight tasks when the host leaves mid-turn?
- Exact length of the batching window.

---

## Technical References (Claude Code)

- Mods (panes, UI changes, events, submitting prompts, messaging between sessions): https://code.claude.com/docs/en/plugins/mods/overview.md
  - Mods require Claude Code v2.1.287 or later.
  - Mod UI draws in the terminal and the Desktop app's Code tab, not in the VS Code extension's chat panel.
- Mod interface (panes, bands above the prompt): https://code.claude.com/docs/en/plugins/mods/interface.md
- Mod events (`tool.call`, prompts, turns): https://code.claude.com/docs/en/plugins/mods/events.md
- Mod API (commands, model calls, background work, network): https://code.claude.com/docs/en/plugins/mods/api.md
- Subagents (per-subagent model): https://code.claude.com/docs/en/sub-agents.md
- Worktrees: https://code.claude.com/docs/en/worktrees.md
- Channels (research preview, allowlisted plugins only): https://code.claude.com/docs/en/channels.md
