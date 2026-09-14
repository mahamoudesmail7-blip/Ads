-- Meta performance snapshot dedup-query indexes — PREPARED, safety-reviewed.
-- Hand-written (never run through `prisma migrate dev`/`diff`) — purely
-- additive: 3 new composite indexes on an existing table. No ALTER, no
-- DROP, no data change.
--
-- Context: a production incident (2026-09-14) traced to
-- services/amb/metricsEngine.js's loadSnapshots() — it fetches every
-- historical snapshot row for a level+window+account, with no bound, and
-- reduces to "latest per entity per day" in JS afterward. On the real
-- account this meant a single ad-level fetch for a 7-day window pulled
-- 97,904 full rows (~222MB) and took 88 seconds; done 3x concurrently
-- inside buildHierarchy() (campaign+adset+ad), this reliably exhausted
-- server memory and OOM-killed the whole Node process. loadSnapshots() was
-- fixed in the same change as this migration to do that "latest per day"
-- reduction as a Postgres DISTINCT ON instead of in JS — which correctly
-- cut the ad-level result down to 669 rows, but without a supporting index
-- Postgres still had to sort the entire unfiltered row set to compute it
-- (35-80 seconds per level). These indexes let it use an index scan.
--
-- NOTE: an earlier version of this migration used `CREATE INDEX
-- CONCURRENTLY`, which failed the deploy — CONCURRENTLY cannot run inside
-- a transaction, and Prisma's `migrate deploy` wraps each migration file
-- in one here. Reverted to plain (transactional) CREATE INDEX: this briefly
-- locks the table against writes while each index builds (acceptable for
-- its current size — a few hundred thousand rows — and the sync job's own
-- 15-36 min write cadence means a lock of a few seconds is a non-issue).
--
-- This migration is intended to run ONCE through the normal Prisma
-- migration flow (`prisma migrate deploy`), which tracks it in
-- `_prisma_migrations` and will not re-apply it. `IF NOT EXISTS` makes it
-- safe to re-run by hand if a prior partial attempt already created one or
-- more of these indexes.

CREATE INDEX IF NOT EXISTS "meta_performance_snapshots_acc_lvl_campaign_date_snap_idx"
    ON "meta_performance_snapshots" ("ad_account_id", "level", "campaign_id", "date_start", "snapshot_at");

CREATE INDEX IF NOT EXISTS "meta_performance_snapshots_acc_lvl_adset_date_snap_idx"
    ON "meta_performance_snapshots" ("ad_account_id", "level", "adset_id", "date_start", "snapshot_at");

CREATE INDEX IF NOT EXISTS "meta_performance_snapshots_acc_lvl_ad_date_snap_idx"
    ON "meta_performance_snapshots" ("ad_account_id", "level", "ad_id", "date_start", "snapshot_at");
