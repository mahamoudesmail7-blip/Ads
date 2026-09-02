-- AlterTable
ALTER TABLE "experimental_creative_results" ADD COLUMN     "final_score" INTEGER,
ADD COLUMN     "visual_match_score" INTEGER;

-- AlterTable
ALTER TABLE "experimental_creative_searches" ADD COLUMN     "identity_profile_json" TEXT,
ADD COLUMN     "reference_image_hash" TEXT,
ADD COLUMN     "search_mode" TEXT NOT NULL DEFAULT 'TEXT';

-- CreateTable
CREATE TABLE "experimental_image_identity_cache" (
    "id" SERIAL NOT NULL,
    "image_hash" TEXT NOT NULL,
    "model_version" TEXT NOT NULL,
    "profile_json" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experimental_image_identity_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "experimental_image_identity_cache_image_hash_model_version_key" ON "experimental_image_identity_cache"("image_hash", "model_version");
