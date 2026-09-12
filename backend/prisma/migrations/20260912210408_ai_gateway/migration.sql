-- CreateTable
CREATE TABLE "ai_usage_log" (
    "id" SERIAL NOT NULL,
    "feature" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "model" TEXT NOT NULL,
    "prompt_version" TEXT,
    "status" TEXT NOT NULL,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "input_tokens" INTEGER,
    "cached_input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "image_count" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_usd" DOUBLE PRECISION,
    "request_id" TEXT,
    "error" TEXT,
    "product_id" INTEGER,
    "user_id" INTEGER,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_cache_entries" (
    "id" SERIAL NOT NULL,
    "cache_key" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "prompt_version" TEXT,
    "data_json" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "ai_cache_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_log_created_at_idx" ON "ai_usage_log"("created_at");

-- CreateIndex
CREATE INDEX "ai_usage_log_feature_idx" ON "ai_usage_log"("feature");

-- CreateIndex
CREATE INDEX "ai_usage_log_status_idx" ON "ai_usage_log"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_cache_entries_cache_key_key" ON "ai_cache_entries"("cache_key");

-- CreateIndex
CREATE INDEX "ai_cache_entries_expires_at_idx" ON "ai_cache_entries"("expires_at");

-- CreateIndex
CREATE INDEX "ai_cache_entries_feature_idx" ON "ai_cache_entries"("feature");

