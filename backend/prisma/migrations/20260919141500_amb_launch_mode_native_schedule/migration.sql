-- Campaign Launch Builder — Launch Mode + native Meta scheduling. Hand-
-- written, purely additive (never diff a migration against production with
-- --shadow-database-url — standing project rule):
--   amb_launch_jobs.launch_mode: NOW | SCHEDULED | PAUSED_REVIEW, defaults
--   to PAUSED_REVIEW (today's existing behavior — every existing/future job
--   that never sets this explicitly is completely unaffected).
--   amb_launch_campaigns.natively_activated_at: when a SCHEDULED campaign's
--   real Meta objects were flipped ACTIVE top-down; null for every other
--   launch mode.
-- No ALTER on any existing column, no DROP, no TRUNCATE, no RENAME, no
-- constraint change on any existing @@unique.
ALTER TABLE "amb_launch_jobs"
    ADD COLUMN "launch_mode" TEXT NOT NULL DEFAULT 'PAUSED_REVIEW';

ALTER TABLE "amb_launch_campaigns"
    ADD COLUMN "natively_activated_at" TIMESTAMP(3);
