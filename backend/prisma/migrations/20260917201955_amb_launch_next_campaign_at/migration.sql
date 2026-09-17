-- Campaign Launch Builder — Phase G bulk publish queue. PREPARED via
-- hand-written SQL (never `prisma migrate dev`/`diff` against production —
-- see the standing shadow-database incident rule). Purely additive: ONE
-- new nullable column on the existing amb_launch_jobs table. No ALTER on
-- any existing column, no DROP, no TRUNCATE, no RENAME, no constraint
-- change on any existing @@unique.
--
-- Intended to run once through `prisma migrate deploy`. A job that predates
-- this column simply reads it back as NULL, which the queue engine treats
-- as "no wait pending" — the same self-healing pattern as every other
-- additive amb_launch_jobs column.
ALTER TABLE "amb_launch_jobs"
    ADD COLUMN "next_campaign_at" TIMESTAMP(3);
