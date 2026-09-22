-- Static-image counterpart to amb_launch_video_assets. Purely additive
-- (new table only, no changes to any existing table) — see
-- AmbLaunchImageAsset's own comment in schema.prisma.
CREATE TABLE "amb_launch_image_assets" (
    "id" SERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "slot_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "content_hash" TEXT,
    "size_bytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "mime_type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "meta_image_hash" TEXT,
    "error" TEXT,
    "hook" TEXT,
    "selling_angle" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_launch_image_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "amb_launch_image_assets_job_id_slot_key_key" ON "amb_launch_image_assets"("job_id", "slot_key");
CREATE INDEX "amb_launch_image_assets_job_id_content_hash_idx" ON "amb_launch_image_assets"("job_id", "content_hash");

ALTER TABLE "amb_launch_image_assets" ADD CONSTRAINT "amb_launch_image_assets_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "amb_launch_jobs"("job_id") ON DELETE CASCADE ON UPDATE CASCADE;
