-- Meta performance snapshot dedup-query indexes — PREPARED, safety-reviewed.
-- Hand-written (never run through `prisma migrate dev`/`diff`) — purely
-- additive: 3 new composite indexes on an existing table, using
-- CONCURRENTLY so building them never blocks the sync job's writes or any
-- read query against meta_performance_snapshots (currently ~218k rows and
-- growing every ~15 minutes). No ALTER, no DROP, no data change.
--
-- Context: a production incident (2026-09-14) traced to
-- services/amb/metricsEngine.js's loadSnapshots() — it fetches every
-- historical snapshot row for a level+window+account, with no bound, and
-- reduces to "latest per entity per day" in JS afterward. On the real
-- account this meant a single ad-level fetch for a 7-day window pulled
-- 97,904 full rows (~222MB) and took 88 seconds; done 3x concurrently
-- inside buildHierarchy() (campaign+adset+ad), this reliably exhausted
-- server memory and OOM-killed the whole Node process (undetectable by any
-- JS-level try/catch or unhandledRejection handler, since an OOM kill is a
-- SIGKILL, not a JS exception). loadSnapshots() was fixed in the same
-- change as this migration to do that "latest per day" reduction as a
-- Postgres DISTINCT ON instead of in JS — which correctly cut the ad-level
-- result down to 669 rows, but without a supporting index Postgres still
-- had to sort the entire unfiltered row set to compute it (35-80 seconds
-- per level). These indexes let it use an index scan instead.
--
-- This migration is intended to run ONCE through the normal Prisma
-- migration flow (`prisma migrate deploy`), which tracks it in
-- `_prisma_migrations` and will not re-apply it. `CREATE INDEX
-- CONCURRENTLY` cannot run inside a transaction — Prisma's migration
-- engine detects this and automatically runs this file without wrapping
-- it in one. It is NOT idempotent if run by hand outside that flow.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "meta_performance_snapshots_acc_lvl_campaign_date_snap_idx"
    ON "meta_performance_snapshots" ("ad_account_id", "level", "campaign_id", "date_start", "snapshot_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "meta_performance_snapshots_acc_lvl_adset_date_snap_idx"
    ON "meta_performance_snapshots" ("ad_account_id", "level", "adset_id", "date_start", "snapshot_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "meta_performance_snapshots_acc_lvl_ad_date_snap_idx"
    ON "meta_performance_snapshots" ("ad_account_id", "level", "ad_id", "date_start", "snapshot_at");
