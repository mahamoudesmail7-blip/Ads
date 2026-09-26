-- Winner Products Discovery Engine ("🔥 منتجات وينر") — Phase 1.
-- Purely additive: four new tables, zero changes to any existing table or
-- column. See the models' own comments in schema.prisma for the full
-- rationale (nullable score/stage fields are computed by a later phase and
-- must never be fabricated in Phase 1).

CREATE TABLE "winner_product_categories" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "label_ar" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "winner_product_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "winner_product_categories_key_key" ON "winner_product_categories"("key");

CREATE TABLE "winner_product_searches" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'EG',
    "time_range" TEXT NOT NULL DEFAULT '7d',
    "mode" TEXT NOT NULL DEFAULT 'quick',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "platform_status_json" TEXT,
    "platform_progress_json" TEXT,
    "queries_json" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "winner_product_searches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "winner_product_searches_user_id_idx" ON "winner_product_searches"("user_id");
CREATE INDEX "winner_product_searches_status_idx" ON "winner_product_searches"("status");

ALTER TABLE "winner_product_searches" ADD CONSTRAINT "winner_product_searches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "winner_products" (
    "id" SERIAL NOT NULL,
    "search_id" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "thumbnail" TEXT,
    "platforms_json" TEXT NOT NULL,
    "videos_count" INTEGER NOT NULL DEFAULT 0,
    "ads_count" INTEGER NOT NULL DEFAULT 0,
    "advertisers_count" INTEGER NOT NULL DEFAULT 0,
    "markets_json" TEXT,
    "trend_stage" TEXT,
    "winner_score" INTEGER,
    "egypt_saturation" INTEGER,
    "opportunity_gap" INTEGER,
    "confidence" INTEGER,
    "growth_pct" DOUBLE PRECISION,
    "raw_sources_json" TEXT,
    "first_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "winner_products_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "winner_products_search_id_idx" ON "winner_products"("search_id");
CREATE INDEX "winner_products_category_idx" ON "winner_products"("category");

ALTER TABLE "winner_products" ADD CONSTRAINT "winner_products_search_id_fkey" FOREIGN KEY ("search_id") REFERENCES "winner_product_searches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "winner_product_saved" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "winner_product_id" INTEGER NOT NULL,
    "snapshot_json" TEXT NOT NULL,
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "winner_product_saved_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "winner_product_saved_user_id_winner_product_id_key" ON "winner_product_saved"("user_id", "winner_product_id");

ALTER TABLE "winner_product_saved" ADD CONSTRAINT "winner_product_saved_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "winner_product_saved" ADD CONSTRAINT "winner_product_saved_winner_product_id_fkey" FOREIGN KEY ("winner_product_id") REFERENCES "winner_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
