-- The room's model defaults (PLAN.md phase 4): JSON like {"hard":"claude-opus-5-5"},
-- set by the host or an admin; null when none are. A member's own choice for
-- their machine is theirs and never reaches the room host.
ALTER TABLE rooms ADD COLUMN models TEXT;
