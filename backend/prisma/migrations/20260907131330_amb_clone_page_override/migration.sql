-- AlterTable
ALTER TABLE "amb_clone_batches" ADD COLUMN     "destination_page_id" TEXT,
ADD COLUMN     "recreate_boosted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "amb_clone_jobs" ADD COLUMN     "destination_page_id" TEXT;
