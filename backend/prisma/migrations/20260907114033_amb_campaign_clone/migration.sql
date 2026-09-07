-- CreateTable
CREATE TABLE "amb_clone_batches" (
    "id" SERIAL NOT NULL,
    "batch_id" TEXT NOT NULL,
    "source_ad_account_id" TEXT NOT NULL,
    "source_ad_account_name" TEXT,
    "destination_account_ids_json" TEXT NOT NULL,
    "campaign_ids_json" TEXT NOT NULL,
    "schedule_local_time" TEXT NOT NULL DEFAULT '00:00',
    "total_copies" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "preflight_json" TEXT,
    "error" TEXT,
    "approved_by_id" INTEGER,
    "approved_at" TIMESTAMP(3),
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_clone_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amb_clone_jobs" (
    "id" SERIAL NOT NULL,
    "batch_id" TEXT NOT NULL,
    "source_ad_account_id" TEXT NOT NULL,
    "destination_ad_account_id" TEXT NOT NULL,
    "destination_account_name" TEXT,
    "destination_timezone" TEXT,
    "source_campaign_id" TEXT NOT NULL,
    "source_campaign_name" TEXT,
    "destination_campaign_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "preflight_status" TEXT NOT NULL DEFAULT 'READY',
    "preflight_json" TEXT,
    "scheduled_activation_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "id_map_json" TEXT,
    "copies_created_json" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_clone_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amb_clone_object_map" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "batch_id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_name" TEXT,
    "parent_source_id" TEXT,
    "destination_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload_json" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_clone_object_map_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amb_clone_audit" (
    "id" SERIAL NOT NULL,
    "batch_id" TEXT NOT NULL,
    "job_id" INTEGER,
    "event" TEXT NOT NULL,
    "level" TEXT,
    "source_id" TEXT,
    "destination_id" TEXT,
    "detail" TEXT,
    "data_json" TEXT,
    "actor_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amb_clone_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "amb_clone_batches_batch_id_key" ON "amb_clone_batches"("batch_id");

-- CreateIndex
CREATE INDEX "amb_clone_batches_status_idx" ON "amb_clone_batches"("status");

-- CreateIndex
CREATE INDEX "amb_clone_batches_created_at_idx" ON "amb_clone_batches"("created_at");

-- CreateIndex
CREATE INDEX "amb_clone_jobs_status_idx" ON "amb_clone_jobs"("status");

-- CreateIndex
CREATE INDEX "amb_clone_jobs_scheduled_activation_at_idx" ON "amb_clone_jobs"("scheduled_activation_at");

-- CreateIndex
CREATE UNIQUE INDEX "amb_clone_jobs_batch_id_destination_ad_account_id_source_ca_key" ON "amb_clone_jobs"("batch_id", "destination_ad_account_id", "source_campaign_id");

-- CreateIndex
CREATE INDEX "amb_clone_object_map_job_id_idx" ON "amb_clone_object_map"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "amb_clone_object_map_job_id_level_source_id_key" ON "amb_clone_object_map"("job_id", "level", "source_id");

-- CreateIndex
CREATE INDEX "amb_clone_audit_batch_id_idx" ON "amb_clone_audit"("batch_id");

-- CreateIndex
CREATE INDEX "amb_clone_audit_created_at_idx" ON "amb_clone_audit"("created_at");

-- AddForeignKey
ALTER TABLE "amb_clone_batches" ADD CONSTRAINT "amb_clone_batches_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amb_clone_batches" ADD CONSTRAINT "amb_clone_batches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amb_clone_jobs" ADD CONSTRAINT "amb_clone_jobs_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "amb_clone_batches"("batch_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amb_clone_object_map" ADD CONSTRAINT "amb_clone_object_map_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "amb_clone_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amb_clone_audit" ADD CONSTRAINT "amb_clone_audit_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "amb_clone_batches"("batch_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amb_clone_audit" ADD CONSTRAINT "amb_clone_audit_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
