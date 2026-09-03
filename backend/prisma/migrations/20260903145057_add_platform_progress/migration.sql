-- AlterTable
ALTER TABLE "experimental_creative_searches" ADD COLUMN     "platform_progress_json" TEXT;

-- RenameIndex
ALTER INDEX "experimental_image_identity_cache_image_hash_model_version_prov" RENAME TO "experimental_image_identity_cache_image_hash_model_version__key";
