-- CreateTable
CREATE TABLE "ai_audit_log" (
    "id" SERIAL NOT NULL,
    "actor_id" INTEGER,
    "kind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "tool_name" TEXT,
    "input_json" TEXT,
    "output_json" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_audit_log_created_at_idx" ON "ai_audit_log"("created_at");

-- CreateIndex
CREATE INDEX "ai_audit_log_kind_idx" ON "ai_audit_log"("kind");

-- AddForeignKey
ALTER TABLE "ai_audit_log" ADD CONSTRAINT "ai_audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
