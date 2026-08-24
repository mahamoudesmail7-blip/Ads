-- AlterTable
ALTER TABLE "easyorders_orders" ADD COLUMN     "customer_address" TEXT,
ADD COLUMN     "customer_government" TEXT,
ADD COLUMN     "customer_name" TEXT,
ADD COLUMN     "customer_phone" TEXT,
ADD COLUMN     "order_cost" DOUBLE PRECISION,
ADD COLUMN     "shipping_cost" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "lost_orders" (
    "id" SERIAL NOT NULL,
    "order_id" TEXT NOT NULL,
    "processing_status" TEXT NOT NULL DEFAULT 'NEW',
    "replacement_order_id" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lost_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lost_order_notes" (
    "id" SERIAL NOT NULL,
    "lost_order_id" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "author_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lost_order_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lost_order_history" (
    "id" SERIAL NOT NULL,
    "lost_order_id" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "actor_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lost_order_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lost_orders_order_id_key" ON "lost_orders"("order_id");

-- CreateIndex
CREATE INDEX "lost_order_notes_lost_order_id_idx" ON "lost_order_notes"("lost_order_id");

-- CreateIndex
CREATE INDEX "lost_order_history_lost_order_id_idx" ON "lost_order_history"("lost_order_id");

-- AddForeignKey
ALTER TABLE "lost_order_notes" ADD CONSTRAINT "lost_order_notes_lost_order_id_fkey" FOREIGN KEY ("lost_order_id") REFERENCES "lost_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_order_notes" ADD CONSTRAINT "lost_order_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_order_history" ADD CONSTRAINT "lost_order_history_lost_order_id_fkey" FOREIGN KEY ("lost_order_id") REFERENCES "lost_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_order_history" ADD CONSTRAINT "lost_order_history_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
