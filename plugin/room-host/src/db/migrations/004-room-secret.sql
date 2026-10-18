-- Handover (PLAN.md phase 3, §5): every room has a secret its members hold.
-- A room host proves it hosts the room by answering a member's challenge with
-- it (protocol/seal.ts hostProof), before the member trusts a new address.
-- Kept as is, not hashed: the room host computes with it. A new one is made
-- when a member is removed. Rooms from before get theirs when first asked.
ALTER TABLE rooms ADD COLUMN secret TEXT;
