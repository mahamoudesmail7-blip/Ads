-- CreateTable
CREATE TABLE "product_research_searches" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER,
    "product_name" TEXT NOT NULL,
    "product_image" TEXT,
    "country" TEXT NOT NULL DEFAULT 'EG',
    "language" TEXT NOT NULL DEFAULT 'AR_EN',
    "platforms_json" TEXT NOT NULL,
    "results_per_platform" INTEGER NOT NULL DEFAULT 25,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "platform_status_json" TEXT,
    "ai_profile_json" TEXT,
    "input_json" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_research_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_research_queries" (
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

    CONSTRAINT "product_research_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_research_results" (
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

    CONSTRAINT "product_research_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_research_competitors" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER,
    "search_id" INTEGER,
    "result_id" INTEGER,
    "platform" TEXT NOT NULL,
    "account_name" TEXT,
    "account_url" TEXT NOT NULL,
    "country" TEXT,
    "follower_count" INTEGER,
    "notes" TEXT,
    "saved_by_id" INTEGER,
    "first_seen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_research_competitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_research_ai_insights" (
    "id" SERIAL NOT NULL,
    "search_id" INTEGER NOT NULL,
    "insights_json" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_research_ai_insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_research_searches_user_id_idx" ON "product_research_searches"("user_id");

-- CreateIndex
CREATE INDEX "product_research_searches_product_id_idx" ON "product_research_searches"("product_id");

-- CreateIndex
CREATE INDEX "product_research_searches_status_idx" ON "product_research_searches"("status");

-- CreateIndex
CREATE INDEX "product_research_queries_search_id_idx" ON "product_research_queries"("search_id");

-- CreateIndex
CREATE INDEX "product_research_results_search_id_idx" ON "product_research_results"("search_id");

-- CreateIndex
CREATE INDEX "product_research_results_platform_idx" ON "product_research_results"("platform");

-- CreateIndex
CREATE INDEX "product_research_results_match_score_idx" ON "product_research_results"("match_score");

-- CreateIndex
CREATE UNIQUE INDEX "product_research_results_search_id_canonical_url_key" ON "product_research_results"("search_id", "canonical_url");

-- CreateIndex
CREATE UNIQUE INDEX "product_research_competitors_result_id_key" ON "product_research_competitors"("result_id");

-- CreateIndex
CREATE INDEX "product_research_competitors_product_id_idx" ON "product_research_competitors"("product_id");

-- CreateIndex
CREATE INDEX "product_research_competitors_search_id_idx" ON "product_research_competitors"("search_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_research_ai_insights_search_id_key" ON "product_research_ai_insights"("search_id");

-- AddForeignKey
ALTER TABLE "product_research_searches" ADD CONSTRAINT "product_research_searches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_research_searches" ADD CONSTRAINT "product_research_searches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_research_queries" ADD CONSTRAINT "product_research_queries_search_id_fkey" FOREIGN KEY ("search_id") REFERENCES "product_research_searches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_research_results" ADD CONSTRAINT "product_research_results_search_id_fkey" FOREIGN KEY ("search_id") REFERENCES "product_research_searches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_research_competitors" ADD CONSTRAINT "product_research_competitors_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_research_competitors" ADD CONSTRAINT "product_research_competitors_search_id_fkey" FOREIGN KEY ("search_id") REFERENCES "product_research_searches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_research_competitors" ADD CONSTRAINT "product_research_competitors_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "product_research_results"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_research_competitors" ADD CONSTRAINT "product_research_competitors_saved_by_id_fkey" FOREIGN KEY ("saved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_research_ai_insights" ADD CONSTRAINT "product_research_ai_insights_search_id_fkey" FOREIGN KEY ("search_id") REFERENCES "product_research_searches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
