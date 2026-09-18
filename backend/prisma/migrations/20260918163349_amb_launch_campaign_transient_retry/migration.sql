-- Campaign Launch Builder — bounded transient-retry bookkeeping for the
-- bulk publish queue. Purely additive: two new nullable/defaulted columns
-- on the existing amb_launch_campaigns table. No ALTER on any existing
-- column, no DROP, no TRUNCATE, no RENAME, no constraint change on any
-- existing @@unique — hand-written per the standing rule (never diff a
-- migration against production with --shadow-database-url).
ALTER TABLE "amb_launch_campaigns"
    ADD COLUMN "next_retry_at" TIMESTAMP(3),
    ADD COLUMN "transient_retry_count" INTEGER NOT NULL DEFAULT 0;
