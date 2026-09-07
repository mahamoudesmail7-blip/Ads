-- CreateTable
CREATE TABLE "media_library_assets" (
    "id" SERIAL NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "primary_format" TEXT NOT NULL DEFAULT 'OTHER',
    "asset_name" TEXT,
    "amb_product_id" INTEGER,
    "link_source" TEXT NOT NULL DEFAULT 'NONE',
    "hook" TEXT,
    "hook_types_json" TEXT,
    "selling_angle" TEXT,
    "creative_type" TEXT,
    "sample_body" TEXT,
    "sample_title" TEXT,
    "sample_cta" TEXT,
    "sample_link_url" TEXT,
    "thumbnail_url" TEXT,
    "page_id" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_library_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_library_creative_refs" (
    "id" SERIAL NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "creative_id" TEXT NOT NULL,
    "creative_name" TEXT,
    "format" TEXT,
    "image_hashes_json" TEXT,
    "video_ids_json" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "clone_job_id" INTEGER,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_library_creative_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_library_scalings" (
    "id" SERIAL NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "source_ad_account_id" TEXT NOT NULL,
    "source_campaign_ids_json" TEXT NOT NULL,
    "destination_account_ids_json" TEXT NOT NULL,
    "clone_batch_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "reason" TEXT,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_library_scalings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_library_assets_fingerprint_key" ON "media_library_assets"("fingerprint");

-- CreateIndex
CREATE INDEX "media_library_assets_amb_product_id_idx" ON "media_library_assets"("amb_product_id");

-- CreateIndex
CREATE INDEX "media_library_assets_primary_format_idx" ON "media_library_assets"("primary_format");

-- CreateIndex
CREATE INDEX "media_library_creative_refs_asset_id_idx" ON "media_library_creative_refs"("asset_id");

-- CreateIndex
CREATE INDEX "media_library_creative_refs_asset_id_ad_account_id_idx" ON "media_library_creative_refs"("asset_id", "ad_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_library_creative_refs_ad_account_id_creative_id_key" ON "media_library_creative_refs"("ad_account_id", "creative_id");

-- CreateIndex
CREATE INDEX "media_library_scalings_asset_id_idx" ON "media_library_scalings"("asset_id");

-- CreateIndex
CREATE INDEX "media_library_scalings_clone_batch_id_idx" ON "media_library_scalings"("clone_batch_id");

-- AddForeignKey
ALTER TABLE "media_library_assets" ADD CONSTRAINT "media_library_assets_amb_product_id_fkey" FOREIGN KEY ("amb_product_id") REFERENCES "amb_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_library_creative_refs" ADD CONSTRAINT "media_library_creative_refs_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_library_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_library_scalings" ADD CONSTRAINT "media_library_scalings_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_library_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_library_scalings" ADD CONSTRAINT "media_library_scalings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
