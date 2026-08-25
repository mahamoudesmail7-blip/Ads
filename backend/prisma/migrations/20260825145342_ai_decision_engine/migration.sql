-- CreateTable
CREATE TABLE "ads_decision_reviews" (
    "id" SERIAL NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reviewed_by_id" INTEGER,
    "reviewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_decision_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ads_action_plans" (
    "id" SERIAL NOT NULL,
    "window_from" TEXT NOT NULL,
    "window_to" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "plan_json" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'AI',
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_action_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ads_decision_reviews_entity_type_entity_key_key" ON "ads_decision_reviews"("entity_type", "entity_key");

-- CreateIndex
CREATE UNIQUE INDEX "ads_action_plans_window_from_window_to_key" ON "ads_action_plans"("window_from", "window_to");

-- AddForeignKey
ALTER TABLE "ads_decision_reviews" ADD CONSTRAINT "ads_decision_reviews_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
