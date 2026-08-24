-- AlterTable
ALTER TABLE "lost_orders" ADD COLUMN     "override_customer_address" TEXT,
ADD COLUMN     "override_customer_government" TEXT,
ADD COLUMN     "override_customer_name" TEXT,
ADD COLUMN     "override_customer_phone" TEXT;
