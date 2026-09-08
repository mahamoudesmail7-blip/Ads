-- CreateTable
CREATE TABLE "amb_scale_decisions" (
    "id" SERIAL NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "source_campaign_id" TEXT NOT NULL,
    "source_campaign_name" TEXT,
    "product_name" TEXT,
    "window_label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "orders" INTEGER,
    "cpa" DOUBLE PRECISION,
    "spend" DOUBLE PRECISION,
    "winner_ads_json" TEXT,
    "budget_egp" DOUBLE PRECISION,
    "exec_mode" TEXT,
    "start_at_cairo" TEXT,
    "clone_batch_id" TEXT,
    "reviewed_by_id" INTEGER,
    "reviewed_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_scale_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "amb_scale_decisions_ad_account_id_source_campaign_id_idx" ON "amb_scale_decisions"("ad_account_id", "source_campaign_id");

-- CreateIndex
CREATE INDEX "amb_scale_decisions_status_idx" ON "amb_scale_decisions"("status");

-- AddForeignKey
ALTER TABLE "amb_scale_decisions" ADD CONSTRAINT "amb_scale_decisions_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
