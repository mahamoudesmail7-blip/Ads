-- Smart Decision Center Phase 1 — deterministic Product<->Launch link, plus
-- per-video-slot hook/selling-angle capture and a direct Product link on the
-- Media Library. Purely additive: five nullable columns, three new
-- non-unique indexes, two new FKs (ON DELETE SET NULL). No ALTER on any
-- existing column, no DROP, no TRUNCATE, no constraint change on any
-- existing @@unique. Safe to run any number of times.
--
-- No backfill UPDATE at all in this migration. Every existing
-- amb_launch_jobs/media_library_assets row stays product_id = NULL forever
-- unless a human explicitly re-associates it later — per the standing rule,
-- campaign-name matching is historical-review-only and must never
-- auto-assign a product to a real, already-submitted launch job.

-- AlterTable
ALTER TABLE "amb_launch_jobs" ADD COLUMN "product_id" INTEGER;
ALTER TABLE "amb_launch_video_assets" ADD COLUMN "hook" TEXT;
ALTER TABLE "amb_launch_video_assets" ADD COLUMN "selling_angle" TEXT;
ALTER TABLE "media_library_assets" ADD COLUMN "product_id" INTEGER;

-- CreateIndex
CREATE INDEX "amb_launch_jobs_product_id_idx" ON "amb_launch_jobs"("product_id");
CREATE INDEX "media_library_assets_product_id_idx" ON "media_library_assets"("product_id");

-- AddForeignKey
ALTER TABLE "amb_launch_jobs" ADD CONSTRAINT "amb_launch_jobs_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "media_library_assets" ADD CONSTRAINT "media_library_assets_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
