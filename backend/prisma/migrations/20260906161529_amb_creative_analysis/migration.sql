-- CreateTable
CREATE TABLE "amb_creative_analysis" (
    "id" SERIAL NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "creative_id" TEXT NOT NULL,
    "model_version" TEXT NOT NULL DEFAULT 'amb-creative-v1',
    "status" TEXT NOT NULL DEFAULT 'NOT_ANALYZED',
    "source" TEXT,
    "hook" TEXT,
    "hook_types_json" TEXT,
    "selling_angle" TEXT,
    "problem" TEXT,
    "main_benefit" TEXT,
    "product_feature" TEXT,
    "audience" TEXT,
    "offer" TEXT,
    "cta" TEXT,
    "creative_type" TEXT,
    "raw_text" TEXT,
    "fields_json" TEXT,
    "analyzed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_creative_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "amb_creative_analysis_ad_account_id_idx" ON "amb_creative_analysis"("ad_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "amb_creative_analysis_creative_id_model_version_key" ON "amb_creative_analysis"("creative_id", "model_version");
