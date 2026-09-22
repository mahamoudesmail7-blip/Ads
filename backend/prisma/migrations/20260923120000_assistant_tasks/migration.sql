-- AI Media Buyer Operator — Task Engine (Phase 2, Slice 1). Purely additive:
-- two new nullable columns on amb_actions (verify-after-write), and one new
-- table. See AssistantTask's own comment in schema.prisma.

ALTER TABLE "amb_actions" ADD COLUMN "verified_at" TIMESTAMP(3);
ALTER TABLE "amb_actions" ADD COLUMN "verify_json" TEXT;

CREATE TABLE "assistant_tasks" (
    "id" SERIAL NOT NULL,
    "task_uuid" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "entity_id" TEXT,
    "entity_type" TEXT,
    "entity_name" TEXT,
    "amb_recommendation_id" INTEGER,
    "amb_action_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "input_json" TEXT,
    "prepared_payload_json" TEXT,
    "approval_hash" TEXT,
    "approved_at" TIMESTAMP(3),
    "approved_by_id" INTEGER,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "blocked_reason" TEXT,
    "conversation_ref" TEXT,
    "heartbeat_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_tasks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assistant_tasks_task_uuid_key" ON "assistant_tasks"("task_uuid");
CREATE INDEX "assistant_tasks_status_idx" ON "assistant_tasks"("status");
CREATE INDEX "assistant_tasks_entity_id_idx" ON "assistant_tasks"("entity_id");
CREATE INDEX "assistant_tasks_user_id_idx" ON "assistant_tasks"("user_id");

ALTER TABLE "assistant_tasks" ADD CONSTRAINT "assistant_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assistant_tasks" ADD CONSTRAINT "assistant_tasks_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assistant_tasks" ADD CONSTRAINT "assistant_tasks_amb_recommendation_id_fkey" FOREIGN KEY ("amb_recommendation_id") REFERENCES "amb_recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assistant_tasks" ADD CONSTRAINT "assistant_tasks_amb_action_id_fkey" FOREIGN KEY ("amb_action_id") REFERENCES "amb_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
