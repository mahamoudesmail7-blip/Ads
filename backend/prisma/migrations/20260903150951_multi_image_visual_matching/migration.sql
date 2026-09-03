-- AlterTable
ALTER TABLE "experimental_creative_results" ADD COLUMN     "match_reasons" TEXT,
ADD COLUMN     "matched_reference_index" INTEGER;

-- AlterTable
ALTER TABLE "experimental_creative_searches" ADD COLUMN     "product_images_json" TEXT;
