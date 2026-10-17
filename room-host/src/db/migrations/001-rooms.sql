-- Room host schema, version 1. One room host serves the rooms of one machine;
-- everything here is deleted when its last room closes (PLAN.md D3, D18).
-- Times are epoch milliseconds. IDs are UUIDs. Logins are GitHub logins, lowercased.

CREATE TABLE rooms (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  visibility  TEXT NOT NULL CHECK (visibility IN ('open', 'private')),
  repo_url    TEXT,
  host_login  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  closed_at   INTEGER
);
-- Names are unique among the open rooms.
CREATE UNIQUE INDEX rooms_open_name ON rooms (name) WHERE closed_at IS NULL;

-- Members past and present; left_at is set on leave or kick.
CREATE TABLE room_members (
  room_id          TEXT NOT NULL REFERENCES rooms(id),
  login            TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  verified         INTEGER NOT NULL CHECK (verified IN (0, 1)),
  key_fingerprint  TEXT,
  joined_at        INTEGER NOT NULL,
  left_at          INTEGER,
  PRIMARY KEY (room_id, login)
);

-- Per-room session tokens (D9), stored as sha256 hashes only.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL,
  login       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (room_id, login) REFERENCES room_members (room_id, login)
);

-- Append-only: the triggers below refuse every change to a written entry.
CREATE TABLE room_log (
  room_id  TEXT NOT NULL REFERENCES rooms(id),
  seq      INTEGER NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('message', 'system', 'task', 'coordinator', 'status')),
  author   TEXT,
  body     TEXT NOT NULL,
  data     TEXT,
  at       INTEGER NOT NULL,
  PRIMARY KEY (room_id, seq)
);
CREATE TRIGGER room_log_no_update BEFORE UPDATE ON room_log
BEGIN SELECT RAISE(ABORT, 'room_log is append-only'); END;
CREATE TRIGGER room_log_no_delete BEFORE DELETE ON room_log
BEGIN SELECT RAISE(ABORT, 'room_log is append-only'); END;

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL REFERENCES rooms(id),
  title       TEXT NOT NULL,
  spec        TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL CHECK (state IN ('open', 'claimed', 'done', 'blocked')),
  difficulty  TEXT CHECK (difficulty IN ('easy', 'medium', 'hard')),
  claimed_by  TEXT,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX tasks_by_room ON tasks (room_id, state);

-- `touching` is not stored here: it is derived from file_touches.
CREATE TABLE room_status (
  room_id     TEXT PRIMARY KEY REFERENCES rooms(id),
  version     INTEGER NOT NULL DEFAULT 0,
  doing       TEXT NOT NULL DEFAULT '',
  decided     TEXT NOT NULL DEFAULT '[]',
  planned     TEXT NOT NULL DEFAULT '[]',
  blocked     TEXT NOT NULL DEFAULT '[]',
  updated_at  INTEGER NOT NULL
);

-- Live file tracking: the latest edit per (room, member, path).
CREATE TABLE file_touches (
  room_id  TEXT NOT NULL REFERENCES rooms(id),
  login    TEXT NOT NULL,
  path     TEXT NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (room_id, login, path)
);
CREATE INDEX file_touches_by_path ON file_touches (path, at);
