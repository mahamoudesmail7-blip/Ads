-- Product Marketing Center — Phase A, real Meta audience/geo/platform
-- breakdown data. PREPARED via hand-written SQL (never `prisma migrate dev`/
-- `diff` against production — see the standing shadow-database incident
-- rule). Purely additive: ONE new nullable column on the existing
-- pmc_snapshots table. No ALTER on any existing column, no DROP, no
-- TRUNCATE, no RENAME, no constraint change on any existing @@unique.
--
-- Intended to run once through `prisma migrate deploy`. A snapshot computed
-- before this column existed simply reads it back as NULL — same
-- self-healing pattern as every other additive pmc_snapshots column.
ALTER TABLE "pmc_snapshots"
    ADD COLUMN "audience_breakdown_json" TEXT;
