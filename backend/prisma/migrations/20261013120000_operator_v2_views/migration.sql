-- AI Operator V2 — saved views + selection snapshots for the campaign center.
-- HAND-WRITTEN SQL (never `prisma migrate dev`/`diff` against this shared production database — standing shadow-database incident rule).
-- Purely additive: two NEW tables, no existing table is touched. NOT applied to production by this change (local only until the owner approves a deploy).

CREATE TABLE "amb_operator_saved_views" (
    "id" SERIAL NOT NULL,
    "owner_id" INTEGER NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'CAMPAIGNS',
    "name" TEXT NOT NULL,
    "config_json" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "shared_min_role" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_operator_saved_views_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "amb_operator_saved_views_owner_id_scope_name_key" ON "amb_operator_saved_views"("owner_id", "scope", "name");
CREATE INDEX "amb_operator_saved_views_shared_scope_idx" ON "amb_operator_saved_views"("shared", "scope");

CREATE TABLE "amb_operator_selection_snapshots" (
    "id" TEXT NOT NULL,
    "owner_id" INTEGER NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'CAMPAIGNS',
    "query_json" TEXT NOT NULL,
    "ids_json" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "ids_hash" TEXT NOT NULL,
    "data_as_of" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "amb_operator_selection_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "amb_operator_selection_snapshots_owner_id_created_at_idx" ON "amb_operator_selection_snapshots"("owner_id", "created_at");
CREATE INDEX "amb_operator_selection_snapshots_expires_at_idx" ON "amb_operator_selection_snapshots"("expires_at");
