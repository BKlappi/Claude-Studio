-- The branch a room's work starts from (PLAN.md D22): task branches and
-- worktrees branch off it. Set by the host's mod at create (the repo's default
-- branch); null when it could not tell.
ALTER TABLE rooms ADD COLUMN base_branch TEXT;
