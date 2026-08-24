-- CreateTable
CREATE TABLE "easyorders_orders" (
    "id" SERIAL NOT NULL,
    "order_id" TEXT NOT NULL,
    "cart_item_id" TEXT NOT NULL,
    "product_id" INTEGER,
    "sku" TEXT,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "raw_status" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "matched" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "easyorders_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "easyorders_orders_date_idx" ON "easyorders_orders"("date");

-- CreateIndex
CREATE INDEX "easyorders_orders_product_id_idx" ON "easyorders_orders"("product_id");

-- CreateIndex
CREATE INDEX "easyorders_orders_order_id_idx" ON "easyorders_orders"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "easyorders_orders_order_id_cart_item_id_key" ON "easyorders_orders"("order_id", "cart_item_id");

-- AddForeignKey
ALTER TABLE "easyorders_orders" ADD CONSTRAINT "easyorders_orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
