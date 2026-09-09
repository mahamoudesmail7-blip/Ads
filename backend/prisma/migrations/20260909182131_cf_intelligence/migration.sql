-- AlterTable
ALTER TABLE "cf_project_items" ADD COLUMN     "plan_meta_json" TEXT;

-- CreateTable
CREATE TABLE "cf_feedback" (
    "id" SERIAL NOT NULL,
    "asset_id" INTEGER NOT NULL,
    "verdict" TEXT NOT NULL,
    "reason" TEXT,
    "note" TEXT,
    "product_category" TEXT,
    "creative_angle" TEXT,
    "style_preset" TEXT,
    "prompt_strategy" TEXT,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cf_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cf_feedback_asset_id_idx" ON "cf_feedback"("asset_id");

-- CreateIndex
CREATE INDEX "cf_feedback_product_category_creative_angle_idx" ON "cf_feedback"("product_category", "creative_angle");

-- AddForeignKey
ALTER TABLE "cf_feedback" ADD CONSTRAINT "cf_feedback_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "cf_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cf_feedback" ADD CONSTRAINT "cf_feedback_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

