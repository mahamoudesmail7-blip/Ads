-- CreateTable
CREATE TABLE "meta_connections" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "connected_by_id" INTEGER,
    "access_token_enc" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "meta_user_id" TEXT,
    "meta_user_name" TEXT,
    "selected_business_id" TEXT,
    "selected_business_name" TEXT,
    "selected_ad_account_id" TEXT,
    "selected_ad_account_name" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3),
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_connections_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "meta_connections" ADD CONSTRAINT "meta_connections_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
