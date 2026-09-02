-- CreateTable
CREATE TABLE "experimental_creative_searches" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "source_mode" TEXT NOT NULL DEFAULT 'INTERNAL_EXPERIMENTAL',
    "product_name" TEXT NOT NULL,
    "product_image" TEXT,
    "country" TEXT NOT NULL DEFAULT 'EG',
    "language" TEXT NOT NULL DEFAULT 'AR_EN',
    "platforms_json" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'quick',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "platform_status_json" TEXT,
    "ai_profile_json" TEXT,
    "input_json" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "experimental_creative_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experimental_creative_queries" (
    "id" SERIAL NOT NULL,
    "search_id" INTEGER NOT NULL,
    "platform" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "query_type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "result_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experimental_creative_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experimental_creative_results" (
    "id" SERIAL NOT NULL,
    "search_id" INTEGER NOT NULL,
    "platform" TEXT NOT NULL,
    "content_type" TEXT NOT NULL DEFAULT 'Unknown',
    "canonical_url" TEXT NOT NULL,
    "original_url" TEXT NOT NULL,
    "title" TEXT,
    "snippet" TEXT,
    "account_name" TEXT,
    "account_url" TEXT,
    "thumbnail" TEXT,
    "published_at" TIMESTAMP(3),
    "metrics_json" TEXT,
    "provider" TEXT NOT NULL,
    "classification" TEXT,
    "match_score" INTEGER,
    "confidence_score" INTEGER,
    "ai_reason" TEXT,
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "raw_metadata_json" TEXT,
    "discovered_by_queries_json" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "experimental_creative_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "experimental_creative_searches_user_id_idx" ON "experimental_creative_searches"("user_id");

-- CreateIndex
CREATE INDEX "experimental_creative_searches_status_idx" ON "experimental_creative_searches"("status");

-- CreateIndex
CREATE INDEX "experimental_creative_queries_search_id_idx" ON "experimental_creative_queries"("search_id");

-- CreateIndex
CREATE INDEX "experimental_creative_results_search_id_idx" ON "experimental_creative_results"("search_id");

-- CreateIndex
CREATE INDEX "experimental_creative_results_platform_idx" ON "experimental_creative_results"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "experimental_creative_results_search_id_canonical_url_key" ON "experimental_creative_results"("search_id", "canonical_url");

-- AddForeignKey
ALTER TABLE "experimental_creative_searches" ADD CONSTRAINT "experimental_creative_searches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experimental_creative_queries" ADD CONSTRAINT "experimental_creative_queries_search_id_fkey" FOREIGN KEY ("search_id") REFERENCES "experimental_creative_searches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experimental_creative_results" ADD CONSTRAINT "experimental_creative_results_search_id_fkey" FOREIGN KEY ("search_id") REFERENCES "experimental_creative_searches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
