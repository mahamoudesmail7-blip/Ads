-- CreateTable
CREATE TABLE "cf_products" (
    "id" SERIAL NOT NULL,
    "amb_product_id" INTEGER,
    "product_id" INTEGER,
    "name" TEXT NOT NULL,
    "internal_name" TEXT,
    "category" TEXT,
    "description" TEXT,
    "specifications" TEXT,
    "benefits" TEXT,
    "use_cases" TEXT,
    "target_audience" TEXT,
    "problems" TEXT,
    "allowed_claims" TEXT,
    "forbidden_claims" TEXT,
    "selling_price" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "notes" TEXT,
    "product_lock_mode" TEXT NOT NULL DEFAULT 'STRICT',
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cf_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cf_reference_images" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "storage_provider" TEXT NOT NULL DEFAULT 'db',
    "storage_key" TEXT NOT NULL,
    "url" TEXT,
    "angle_label" TEXT,
    "mime" TEXT NOT NULL DEFAULT 'image/jpeg',
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cf_reference_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cf_product_dna" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "data_json" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "version" INTEGER NOT NULL DEFAULT 1,
    "reviewed_by_user" BOOLEAN NOT NULL DEFAULT false,
    "model_version" TEXT NOT NULL DEFAULT 'cf-dna-v1',
    "source" TEXT NOT NULL DEFAULT 'AI_ANALYZED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cf_product_dna_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cf_projects" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "project_type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "quantity_mode" TEXT NOT NULL DEFAULT 'MANUAL',
    "ai_quantity_reason" TEXT,
    "generation_mode" TEXT NOT NULL DEFAULT 'FAST',
    "style_preset" TEXT,
    "market" TEXT NOT NULL DEFAULT 'EG',
    "language" TEXT NOT NULL DEFAULT 'ar',
    "dialect" TEXT NOT NULL DEFAULT 'egyptian',
    "aspect_ratio" TEXT NOT NULL DEFAULT '1:1',
    "text_density" TEXT NOT NULL DEFAULT 'MINIMAL',
    "people_rule" TEXT NOT NULL DEFAULT 'NONE',
    "hijab_required" BOOLEAN NOT NULL DEFAULT false,
    "product_lock_mode" TEXT NOT NULL DEFAULT 'STRICT',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "plan_notes" TEXT,
    "estimated_cost" DOUBLE PRECISION,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "cf_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cf_project_items" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "purpose" TEXT,
    "angle" TEXT,
    "scene" TEXT,
    "product_placement" TEXT,
    "camera_angle" TEXT,
    "composition" TEXT,
    "background" TEXT,
    "headline" TEXT,
    "supporting_copy" TEXT,
    "cta" TEXT,
    "features_json" TEXT,
    "reference_priority_json" TEXT,
    "visual_style" TEXT,
    "reason" TEXT,
    "creative_direction_json" TEXT,
    "continuity_json" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "approved_asset_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cf_project_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cf_creative_copy" (
    "id" SERIAL NOT NULL,
    "project_item_id" INTEGER NOT NULL,
    "hook" TEXT,
    "supporting_line" TEXT,
    "feature_callouts_json" TEXT,
    "cta" TEXT,
    "headline" TEXT,
    "subtitle" TEXT,
    "alignment" TEXT,
    "priority" TEXT,
    "safe_area" TEXT,
    "claim_status" TEXT NOT NULL DEFAULT 'PENDING',
    "claim_issues_json" TEXT,
    "edited_by_user" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cf_creative_copy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cf_generation_attempts" (
    "id" SERIAL NOT NULL,
    "project_item_id" INTEGER NOT NULL,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT NOT NULL DEFAULT 'disabled',
    "model" TEXT,
    "prompt" TEXT,
    "prompt_version" INTEGER NOT NULL DEFAULT 1,
    "corrective_prompt" TEXT,
    "provider_request_json" TEXT,
    "provider_metadata_json" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "images_requested" INTEGER NOT NULL DEFAULT 1,
    "usage_json" TEXT,
    "estimated_cost" DOUBLE PRECISION,
    "actual_cost" DOUBLE PRECISION,
    "duration_ms" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cf_generation_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cf_assets" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "project_item_id" INTEGER,
    "generation_attempt_id" INTEGER,
    "parent_asset_id" INTEGER,
    "product_id" INTEGER,
    "storage_provider" TEXT NOT NULL DEFAULT 'db',
    "storage_key" TEXT NOT NULL,
    "url" TEXT,
    "thumbnail_key" TEXT,
    "mime" TEXT NOT NULL DEFAULT 'image/png',
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "kind" TEXT NOT NULL DEFAULT 'GENERATED',
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "is_candidate" BOOLEAN NOT NULL DEFAULT false,
    "candidate_rank" INTEGER,
    "variation_type" TEXT,
    "generation_number" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cf_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cf_asset_blobs" (
    "id" SERIAL NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cf_asset_blobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cf_quality_reviews" (
    "id" SERIAL NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "overall_score" DOUBLE PRECISION,
    "product_accuracy_score" DOUBLE PRECISION,
    "identity_score" DOUBLE PRECISION,
    "visual_quality_score" DOUBLE PRECISION,
    "composition_score" DOUBLE PRECISION,
    "product_visibility_score" DOUBLE PRECISION,
    "marketing_score" DOUBLE PRECISION,
    "arabic_text_score" DOUBLE PRECISION,
    "text_readability_score" DOUBLE PRECISION,
    "claim_score" DOUBLE PRECISION,
    "artifact_score" DOUBLE PRECISION,
    "reference_consistency_score" DOUBLE PRECISION,
    "plan_compliance_score" DOUBLE PRECISION,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "failure_reasons_json" TEXT,
    "recommendation" TEXT,
    "review_output_json" TEXT,
    "judge_model" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cf_quality_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cf_jobs" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "project_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PROJECT_GENERATION',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "total_items" INTEGER NOT NULL DEFAULT 0,
    "completed_items" INTEGER NOT NULL DEFAULT 0,
    "failed_items" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "item_ids_json" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3),
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cf_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cf_variations" (
    "id" SERIAL NOT NULL,
    "parent_asset_id" INTEGER NOT NULL,
    "child_asset_id" INTEGER,
    "project_id" INTEGER,
    "variation_type" TEXT NOT NULL,
    "generation_number" INTEGER NOT NULL DEFAULT 1,
    "instructions_json" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cf_variations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cf_performance_links" (
    "id" SERIAL NOT NULL,
    "asset_uuid" TEXT NOT NULL,
    "asset_id" INTEGER,
    "ad_account_id" TEXT,
    "meta_ad_id" TEXT,
    "meta_creative_id" TEXT,
    "campaign_name" TEXT,
    "adset_name" TEXT,
    "ad_name" TEXT,
    "linked_by" TEXT NOT NULL DEFAULT 'MANUAL',
    "spend" DOUBLE PRECISION,
    "impressions" INTEGER,
    "clicks" INTEGER,
    "ctr" DOUBLE PRECISION,
    "cpc" DOUBLE PRECISION,
    "purchases" INTEGER,
    "cpa" DOUBLE PRECISION,
    "cvr" DOUBLE PRECISION,
    "roas" DOUBLE PRECISION,
    "revenue" DOUBLE PRECISION,
    "sample_size" INTEGER,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cf_performance_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cf_learning_insights" (
    "id" SERIAL NOT NULL,
    "dimension" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sample_size" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION,
    "avg_cpa" DOUBLE PRECISION,
    "avg_roas" DOUBLE PRECISION,
    "avg_ctr" DOUBLE PRECISION,
    "win_rate" DOUBLE PRECISION,
    "verdict" TEXT,
    "evidence_json" TEXT,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cf_learning_insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cf_products_amb_product_id_key" ON "cf_products"("amb_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "cf_products_product_id_key" ON "cf_products"("product_id");

-- CreateIndex
CREATE INDEX "cf_products_amb_product_id_idx" ON "cf_products"("amb_product_id");

-- CreateIndex
CREATE INDEX "cf_reference_images_product_id_idx" ON "cf_reference_images"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "cf_product_dna_product_id_key" ON "cf_product_dna"("product_id");

-- CreateIndex
CREATE INDEX "cf_projects_product_id_idx" ON "cf_projects"("product_id");

-- CreateIndex
CREATE INDEX "cf_projects_status_idx" ON "cf_projects"("status");

-- CreateIndex
CREATE INDEX "cf_project_items_project_id_idx" ON "cf_project_items"("project_id");

-- CreateIndex
CREATE INDEX "cf_project_items_status_idx" ON "cf_project_items"("status");

-- CreateIndex
CREATE UNIQUE INDEX "cf_creative_copy_project_item_id_key" ON "cf_creative_copy"("project_item_id");

-- CreateIndex
CREATE INDEX "cf_generation_attempts_project_item_id_idx" ON "cf_generation_attempts"("project_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "cf_assets_uuid_key" ON "cf_assets"("uuid");

-- CreateIndex
CREATE INDEX "cf_assets_project_item_id_idx" ON "cf_assets"("project_item_id");

-- CreateIndex
CREATE INDEX "cf_assets_product_id_idx" ON "cf_assets"("product_id");

-- CreateIndex
CREATE INDEX "cf_assets_status_idx" ON "cf_assets"("status");

-- CreateIndex
CREATE UNIQUE INDEX "cf_asset_blobs_asset_id_key" ON "cf_asset_blobs"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "cf_quality_reviews_asset_id_key" ON "cf_quality_reviews"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "cf_jobs_uuid_key" ON "cf_jobs"("uuid");

-- CreateIndex
CREATE INDEX "cf_jobs_project_id_idx" ON "cf_jobs"("project_id");

-- CreateIndex
CREATE INDEX "cf_jobs_status_idx" ON "cf_jobs"("status");

-- CreateIndex
CREATE INDEX "cf_variations_parent_asset_id_idx" ON "cf_variations"("parent_asset_id");

-- CreateIndex
CREATE INDEX "cf_performance_links_asset_id_idx" ON "cf_performance_links"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "cf_performance_links_asset_uuid_meta_ad_id_key" ON "cf_performance_links"("asset_uuid", "meta_ad_id");

-- CreateIndex
CREATE UNIQUE INDEX "cf_learning_insights_dimension_key_key" ON "cf_learning_insights"("dimension", "key");

-- AddForeignKey
ALTER TABLE "cf_products" ADD CONSTRAINT "cf_products_amb_product_id_fkey" FOREIGN KEY ("amb_product_id") REFERENCES "amb_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_products" ADD CONSTRAINT "cf_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_products" ADD CONSTRAINT "cf_products_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_reference_images" ADD CONSTRAINT "cf_reference_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "cf_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_product_dna" ADD CONSTRAINT "cf_product_dna_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "cf_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_projects" ADD CONSTRAINT "cf_projects_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "cf_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_projects" ADD CONSTRAINT "cf_projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_project_items" ADD CONSTRAINT "cf_project_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "cf_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_creative_copy" ADD CONSTRAINT "cf_creative_copy_project_item_id_fkey" FOREIGN KEY ("project_item_id") REFERENCES "cf_project_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_generation_attempts" ADD CONSTRAINT "cf_generation_attempts_project_item_id_fkey" FOREIGN KEY ("project_item_id") REFERENCES "cf_project_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_assets" ADD CONSTRAINT "cf_assets_project_item_id_fkey" FOREIGN KEY ("project_item_id") REFERENCES "cf_project_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_assets" ADD CONSTRAINT "cf_assets_generation_attempt_id_fkey" FOREIGN KEY ("generation_attempt_id") REFERENCES "cf_generation_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_assets" ADD CONSTRAINT "cf_assets_parent_asset_id_fkey" FOREIGN KEY ("parent_asset_id") REFERENCES "cf_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_assets" ADD CONSTRAINT "cf_assets_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "cf_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_asset_blobs" ADD CONSTRAINT "cf_asset_blobs_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "cf_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_quality_reviews" ADD CONSTRAINT "cf_quality_reviews_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "cf_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_jobs" ADD CONSTRAINT "cf_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "cf_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_jobs" ADD CONSTRAINT "cf_jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_variations" ADD CONSTRAINT "cf_variations_parent_asset_id_fkey" FOREIGN KEY ("parent_asset_id") REFERENCES "cf_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_variations" ADD CONSTRAINT "cf_variations_child_asset_id_fkey" FOREIGN KEY ("child_asset_id") REFERENCES "cf_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_variations" ADD CONSTRAINT "cf_variations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_performance_links" ADD CONSTRAINT "cf_performance_links_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "cf_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

