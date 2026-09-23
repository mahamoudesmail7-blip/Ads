-- AI Media Buyer Operator — Phase 2 Slice 2. Links a LAUNCH_CAMPAIGN
-- AssistantTask to the AmbLaunchJob it owns. Purely additive: one nullable
-- column, no FK (AmbLaunchJob is keyed by job_id, mirrors entity_id's
-- existing no-FK convention on this table). See AssistantTask's own
-- comment in schema.prisma.

ALTER TABLE "assistant_tasks" ADD COLUMN "launch_job_id" TEXT;
CREATE INDEX "assistant_tasks_launch_job_id_idx" ON "assistant_tasks"("launch_job_id");
