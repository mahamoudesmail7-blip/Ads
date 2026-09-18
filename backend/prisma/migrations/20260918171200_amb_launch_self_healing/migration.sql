-- Campaign Launch Builder — self-healing / automatic recovery engine.
-- Hand-written, purely additive (never diff a migration against
-- production with --shadow-database-url — standing project rule):
--   amb_launch_jobs: a cross-instance scheduler lease so two Railway
--   workers can never act on the same job concurrently.
--   amb_launch_campaigns: error classification + when a campaign's
--   current retry/wait window first began + whether it's parked waiting
--   on a human (auth/config/permission/validation/unknown), for the
--   Error Playbook Registry's observability panel.
-- No ALTER on any existing column, no DROP, no TRUNCATE, no RENAME, no
-- constraint change on any existing @@unique.
ALTER TABLE "amb_launch_jobs"
    ADD COLUMN "locked_by" TEXT,
    ADD COLUMN "lock_expires_at" TIMESTAMP(3);

ALTER TABLE "amb_launch_campaigns"
    ADD COLUMN "error_classification" TEXT,
    ADD COLUMN "first_failure_at" TIMESTAMP(3),
    ADD COLUMN "human_action_required" BOOLEAN NOT NULL DEFAULT false;
