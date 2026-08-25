-- CreateTable
CREATE TABLE "ads_uploads" (
    "id" SERIAL NOT NULL,
    "filename" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "row_count" INTEGER,
    "uploaded_by_id" INTEGER,
    "column_mapping" TEXT,
    "errors" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "ads_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ads_raw_rows" (
    "id" SERIAL NOT NULL,
    "upload_id" INTEGER NOT NULL,
    "row_index" INTEGER NOT NULL,
    "raw_data" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_raw_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ads_daily_metrics" (
    "id" SERIAL NOT NULL,
    "upload_id" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "campaign_id" TEXT,
    "campaign_name" TEXT,
    "adset_id" TEXT,
    "adset_name" TEXT,
    "ad_id" TEXT,
    "ad_name" TEXT,
    "creative_id" TEXT,
    "creative_name" TEXT,
    "spend" DOUBLE PRECISION,
    "impressions" INTEGER,
    "reach" INTEGER,
    "frequency" DOUBLE PRECISION,
    "clicks" INTEGER,
    "ctr" DOUBLE PRECISION,
    "cpc" DOUBLE PRECISION,
    "cpm" DOUBLE PRECISION,
    "landing_page_views" INTEGER,
    "leads" INTEGER,
    "add_to_cart" INTEGER,
    "initiate_checkout" INTEGER,
    "meta_purchases" INTEGER,
    "meta_revenue" DOUBLE PRECISION,
    "meta_roas" DOUBLE PRECISION,
    "matched_product_id" INTEGER,
    "match_confidence" DOUBLE PRECISION,
    "match_method" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_daily_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ads_raw_rows_upload_id_idx" ON "ads_raw_rows"("upload_id");

-- CreateIndex
CREATE INDEX "ads_daily_metrics_date_idx" ON "ads_daily_metrics"("date");

-- CreateIndex
CREATE INDEX "ads_daily_metrics_campaign_name_idx" ON "ads_daily_metrics"("campaign_name");

-- CreateIndex
CREATE INDEX "ads_daily_metrics_matched_product_id_idx" ON "ads_daily_metrics"("matched_product_id");

-- AddForeignKey
ALTER TABLE "ads_uploads" ADD CONSTRAINT "ads_uploads_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads_raw_rows" ADD CONSTRAINT "ads_raw_rows_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "ads_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads_daily_metrics" ADD CONSTRAINT "ads_daily_metrics_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "ads_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads_daily_metrics" ADD CONSTRAINT "ads_daily_metrics_matched_product_id_fkey" FOREIGN KEY ("matched_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
