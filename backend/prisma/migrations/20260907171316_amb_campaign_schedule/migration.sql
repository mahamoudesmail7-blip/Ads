-- CreateTable
CREATE TABLE "amb_campaign_schedules" (
    "id" SERIAL NOT NULL,
    "clone_job_id" INTEGER NOT NULL,
    "batch_id" TEXT NOT NULL,
    "destination_ad_account_id" TEXT NOT NULL,
    "destination_account_name" TEXT,
    "source_account_name" TEXT,
    "destination_campaign_id" TEXT,
    "campaign_name" TEXT,
    "mode" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Cairo',
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3),
    "start_local" TEXT,
    "end_local" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approval_required" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" INTEGER,
    "approved_by_id" INTEGER,
    "approved_at" TIMESTAMP(3),
    "cancelled_by_id" INTEGER,
    "cancelled_at" TIMESTAMP(3),
    "actual_start_at" TIMESTAMP(3),
    "actual_end_at" TIMESTAMP(3),
    "start_meta_response_json" TEXT,
    "end_meta_response_json" TEXT,
    "intervention_reason" TEXT,
    "last_error" TEXT,
    "edits_json" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_campaign_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "amb_campaign_schedules_status_idx" ON "amb_campaign_schedules"("status");

-- CreateIndex
CREATE INDEX "amb_campaign_schedules_start_at_idx" ON "amb_campaign_schedules"("start_at");

-- CreateIndex
CREATE INDEX "amb_campaign_schedules_end_at_idx" ON "amb_campaign_schedules"("end_at");

-- CreateIndex
CREATE INDEX "amb_campaign_schedules_clone_job_id_idx" ON "amb_campaign_schedules"("clone_job_id");

-- CreateIndex
CREATE INDEX "amb_campaign_schedules_batch_id_idx" ON "amb_campaign_schedules"("batch_id");

-- AddForeignKey
ALTER TABLE "amb_campaign_schedules" ADD CONSTRAINT "amb_campaign_schedules_clone_job_id_fkey" FOREIGN KEY ("clone_job_id") REFERENCES "amb_clone_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
