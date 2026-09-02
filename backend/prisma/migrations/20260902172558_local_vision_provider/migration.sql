-- AlterTable
ALTER TABLE "experimental_creative_searches" ADD COLUMN "identity_provider" TEXT;

-- AlterTable
ALTER TABLE "experimental_creative_results" ADD COLUMN "local_visual_match_score" INTEGER,
ADD COLUMN "visual_match_provider" TEXT;

-- AlterTable
ALTER TABLE "experimental_image_identity_cache" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'ANTHROPIC_VISION';

-- DropIndex
DROP INDEX "experimental_image_identity_cache_image_hash_model_version_key";

-- CreateIndex
CREATE UNIQUE INDEX "experimental_image_identity_cache_image_hash_model_version_provider_key" ON "experimental_image_identity_cache"("image_hash", "model_version", "provider");
