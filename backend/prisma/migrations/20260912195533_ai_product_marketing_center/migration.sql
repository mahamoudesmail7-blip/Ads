-- CreateTable
CREATE TABLE "pmc_profiles" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER,
    "source" TEXT NOT NULL,
    "locked_name" TEXT NOT NULL,
    "easy_orders_product_id" TEXT,
    "easy_orders_slug" TEXT,
    "selling_price" DOUBLE PRECISION,
    "primary_image_url" TEXT,
    "confirmed_traits_json" TEXT,
    "potential_traits_json" TEXT,
    "unconfirmed_traits_json" TEXT,
    "vision_profile_json" TEXT,
    "locked_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pmc_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pmc_images" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "data_url" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pmc_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pmc_snapshots" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "window_name" TEXT NOT NULL,
    "ad_account_id" TEXT,
    "metrics_json" TEXT NOT NULL,
    "opportunity_json" TEXT NOT NULL,
    "diagnosis_json" TEXT NOT NULL,
    "audience_json" TEXT NOT NULL,
    "locations_json" TEXT NOT NULL,
    "angles_json" TEXT NOT NULL,
    "winning_formula_json" TEXT,
    "actions_json" TEXT NOT NULL,
    "ai_model_version" TEXT NOT NULL DEFAULT 'pmc-v1',
    "ai_raw_json" TEXT,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pmc_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pmc_memory" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "previous_json" TEXT,
    "new_json" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pmc_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pmc_actions" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "action_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "decided_by_id" INTEGER,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pmc_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pmc_profiles_product_id_idx" ON "pmc_profiles"("product_id");

-- CreateIndex
CREATE INDEX "pmc_images_profile_id_idx" ON "pmc_images"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "pmc_snapshots_profile_id_window_name_key" ON "pmc_snapshots"("profile_id", "window_name");

-- CreateIndex
CREATE INDEX "pmc_memory_profile_id_field_idx" ON "pmc_memory"("profile_id", "field");

-- CreateIndex
CREATE INDEX "pmc_actions_profile_id_idx" ON "pmc_actions"("profile_id");

-- AddForeignKey
ALTER TABLE "pmc_profiles" ADD CONSTRAINT "pmc_profiles_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pmc_profiles" ADD CONSTRAINT "pmc_profiles_locked_by_id_fkey" FOREIGN KEY ("locked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pmc_images" ADD CONSTRAINT "pmc_images_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "pmc_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pmc_snapshots" ADD CONSTRAINT "pmc_snapshots_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "pmc_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pmc_memory" ADD CONSTRAINT "pmc_memory_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "pmc_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pmc_actions" ADD CONSTRAINT "pmc_actions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "pmc_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pmc_actions" ADD CONSTRAINT "pmc_actions_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

