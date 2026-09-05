-- AlterTable
ALTER TABLE "experimental_creative_results" ADD COLUMN     "ad_analysis_json" TEXT,
ADD COLUMN     "ad_analysis_status" TEXT,
ADD COLUMN     "ad_analyzed_at" TIMESTAMP(3),
ADD COLUMN     "exact_match_score" INTEGER,
ADD COLUMN     "match_decision" TEXT;

-- CreateTable
CREATE TABLE "experimental_ad_analysis_cache" (
    "id" SERIAL NOT NULL,
    "ad_key" TEXT NOT NULL,
    "model_version" TEXT NOT NULL,
    "analysis_json" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experimental_ad_analysis_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "experimental_ad_analysis_cache_ad_key_model_version_key" ON "experimental_ad_analysis_cache"("ad_key", "model_version");
