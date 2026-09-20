-- Smart Decision Center — the business Conversion Rate formula requires the
-- REAL Landing Page Views denominator (Meta's `landing_page_view` action
-- type), never Clicks/Impressions/Purchases substituted in its place.
-- Purely additive: one nullable column, zero backfill, zero row rewrite.
-- Existing rows keep landing_page_views = NULL until either a future sync
-- populates it going forward, or a separate, explicit backfill script
-- re-derives it from the already-stored actions_json (never fabricated).
ALTER TABLE "meta_performance_snapshots" ADD COLUMN "landing_page_views" INTEGER;
