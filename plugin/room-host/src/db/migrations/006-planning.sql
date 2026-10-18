-- Planning and review (PLAN.md phase 4, protocol/planning.ts). A task may need
-- a plan first (its run splits it into subtasks, which name it as parent), has
-- acceptance checks (JSON list), and keeps where its reviews stand: the slot
-- they moved it to (null: its difficulty's), reviewed runs, failed reviews on
-- its current slot, and the latest review (JSON).
ALTER TABLE tasks ADD COLUMN needs_plan INTEGER NOT NULL DEFAULT 0 CHECK (needs_plan IN (0, 1));
ALTER TABLE tasks ADD COLUMN parent_id TEXT;
ALTER TABLE tasks ADD COLUMN checks TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN slot TEXT CHECK (slot IN ('easy', 'medium', 'hard'));
ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN failed_reviews INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN last_review TEXT;
CREATE INDEX tasks_by_parent ON tasks (parent_id) WHERE parent_id IS NOT NULL;
