-- AlterTable
ALTER TABLE "ads_daily_metrics" ADD COLUMN     "campaign_delivery" TEXT,
ADD COLUMN     "cost_per_result" DOUBLE PRECISION,
ADD COLUMN     "result_indicator" TEXT,
ADD COLUMN     "results" INTEGER;
