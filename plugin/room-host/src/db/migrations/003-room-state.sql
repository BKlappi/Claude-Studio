-- The coordinator (PLAN.md phase 3): the room state it keeps, the log seq it
-- has read up to, and the room's batching window. `doc` holds goals,
-- decisions, questions and asks as JSON; `version` goes up with each commit.
CREATE TABLE room_state (
  room_id             TEXT PRIMARY KEY REFERENCES rooms(id),
  version             INTEGER NOT NULL DEFAULT 0,
  coordinator_cursor  INTEGER NOT NULL DEFAULT 0,
  doc                 TEXT NOT NULL DEFAULT '{}',
  debounce_ms         INTEGER NOT NULL DEFAULT 4000,
  updated_at          INTEGER NOT NULL
);
-- Rooms from before: the coordinator starts after what was said so far.
INSERT INTO room_state (room_id, coordinator_cursor, updated_at)
  SELECT id, (SELECT COALESCE(MAX(seq), 0) FROM room_log WHERE room_log.room_id = rooms.id), created_at FROM rooms;

-- Whose requests a task carries (JSON list of logins): its maker's, or the
-- authors of the messages the coordinator made it from or merged into it.
ALTER TABLE tasks ADD COLUMN asked_by TEXT NOT NULL DEFAULT '[]';
UPDATE tasks SET asked_by = json_array(created_by);
