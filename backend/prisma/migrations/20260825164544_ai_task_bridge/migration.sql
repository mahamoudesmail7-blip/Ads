-- AlterTable
ALTER TABLE "task_records" ADD COLUMN     "ai_recommendation_snapshot" TEXT,
ADD COLUMN     "employee_result" TEXT,
ADD COLUMN     "manager_review_note" TEXT,
ADD COLUMN     "review_status" TEXT,
ADD COLUMN     "source_entity_key" TEXT,
ADD COLUMN     "source_entity_type" TEXT;

-- CreateIndex
CREATE INDEX "task_records_source_entity_type_source_entity_key_idx" ON "task_records"("source_entity_type", "source_entity_key");
