-- Private rooms have a room key (invite links carry it; PLAN.md phase 1). The
-- room host keeps only its sha256: a join must present the key itself.
ALTER TABLE rooms ADD COLUMN key_hash TEXT;
