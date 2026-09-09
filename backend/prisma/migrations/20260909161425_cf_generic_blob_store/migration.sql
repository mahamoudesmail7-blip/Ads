-- DropForeignKey
ALTER TABLE "cf_asset_blobs" DROP CONSTRAINT "cf_asset_blobs_asset_id_fkey";

-- DropTable
DROP TABLE "cf_asset_blobs";

-- CreateTable
CREATE TABLE "cf_blobs" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "mime" TEXT NOT NULL DEFAULT 'image/png',
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cf_blobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cf_blobs_key_key" ON "cf_blobs"("key");

