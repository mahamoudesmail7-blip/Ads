-- AlterTable
ALTER TABLE "lost_orders" ADD COLUMN     "manual_reason" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'AUTO';
