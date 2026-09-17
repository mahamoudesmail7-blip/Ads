-- Campaign Launch Builder ("رفع الكامبين") — Phase B, DB models only.
-- PREPARED via hand-written SQL (never `prisma migrate dev`/`diff` against
-- production — see the standing shadow-database incident rule). Purely
-- additive: 5 brand-new tables, zero ALTER/DROP/RENAME on any existing
-- table or column, zero change to any existing @@unique/index. Intended to
-- run once through `prisma migrate deploy`.
--
-- Deliberately separate from the amb_clone_* tables (a launch job creates
-- brand-new campaigns from scratch; a clone job copies an existing one).
-- Modeled on the same durable/idempotent shape as AmbCloneBatch/Job/
-- ObjectMap/Audit, proven safe in production for real Meta writes.

CREATE TABLE "amb_launch_jobs" (
    "id" SERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "ad_account_name" TEXT,
    "page_id" TEXT,
    "page_name" TEXT,
    "instagram_id" TEXT,
    "instagram_username" TEXT,
    "objective" TEXT NOT NULL DEFAULT 'OUTCOME_SALES',
    "budget_mode" TEXT NOT NULL,
    "pixel_id" TEXT,
    "pixel_name" TEXT,
    "conversion_event" TEXT NOT NULL DEFAULT 'PURCHASE',
    "per_campaign_pixel" BOOLEAN NOT NULL DEFAULT false,
    "platforms_json" TEXT NOT NULL DEFAULT '["facebook","instagram"]',
    "ad_sets_per_campaign" INTEGER NOT NULL DEFAULT 1,
    "ads_per_ad_set" INTEGER NOT NULL DEFAULT 1,
    "campaign_count" INTEGER NOT NULL DEFAULT 1,
    "start_mode" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "start_at" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Cairo',
    "config_json" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "error" TEXT,
    "approved_by_id" INTEGER,
    "approved_at" TIMESTAMP(3),
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_launch_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "amb_launch_jobs_job_id_key" ON "amb_launch_jobs"("job_id");
CREATE INDEX "amb_launch_jobs_status_idx" ON "amb_launch_jobs"("status");
CREATE INDEX "amb_launch_jobs_ad_account_id_idx" ON "amb_launch_jobs"("ad_account_id");

ALTER TABLE "amb_launch_jobs" ADD CONSTRAINT "amb_launch_jobs_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "amb_launch_jobs" ADD CONSTRAINT "amb_launch_jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "amb_launch_campaigns" (
    "id" SERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "pixel_id" TEXT,
    "pixel_name" TEXT,
    "primary_text" TEXT,
    "headline" TEXT,
    "website_url" TEXT,
    "meta_campaign_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_launch_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "amb_launch_campaigns_job_id_index_key" ON "amb_launch_campaigns"("job_id", "index");
CREATE INDEX "amb_launch_campaigns_status_idx" ON "amb_launch_campaigns"("status");

ALTER TABLE "amb_launch_campaigns" ADD CONSTRAINT "amb_launch_campaigns_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "amb_launch_jobs"("job_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "amb_launch_object_map" (
    "id" SERIAL NOT NULL,
    "campaign_id" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "local_key" TEXT NOT NULL,
    "parent_local_key" TEXT,
    "destination_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload_json" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_launch_object_map_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "amb_launch_object_map_campaign_id_level_local_key_key" ON "amb_launch_object_map"("campaign_id", "level", "local_key");
CREATE INDEX "amb_launch_object_map_campaign_id_idx" ON "amb_launch_object_map"("campaign_id");

ALTER TABLE "amb_launch_object_map" ADD CONSTRAINT "amb_launch_object_map_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "amb_launch_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "amb_launch_video_assets" (
    "id" SERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "slot_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "content_hash" TEXT,
    "size_bytes" INTEGER,
    "duration_seconds" DOUBLE PRECISION,
    "mime_type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "meta_video_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_launch_video_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "amb_launch_video_assets_job_id_slot_key_key" ON "amb_launch_video_assets"("job_id", "slot_key");
CREATE INDEX "amb_launch_video_assets_job_id_content_hash_idx" ON "amb_launch_video_assets"("job_id", "content_hash");

ALTER TABLE "amb_launch_video_assets" ADD CONSTRAINT "amb_launch_video_assets_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "amb_launch_jobs"("job_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "amb_launch_audit" (
    "id" SERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "campaign_id" INTEGER,
    "event" TEXT NOT NULL,
    "level" TEXT,
    "local_key" TEXT,
    "destination_id" TEXT,
    "detail" TEXT,
    "data_json" TEXT,
    "actor_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amb_launch_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "amb_launch_audit_job_id_idx" ON "amb_launch_audit"("job_id");
CREATE INDEX "amb_launch_audit_created_at_idx" ON "amb_launch_audit"("created_at");

ALTER TABLE "amb_launch_audit" ADD CONSTRAINT "amb_launch_audit_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "amb_launch_jobs"("job_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "amb_launch_audit" ADD CONSTRAINT "amb_launch_audit_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
