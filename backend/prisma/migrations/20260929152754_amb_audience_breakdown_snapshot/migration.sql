-- Live Campaign Intelligence Slice 2 — audience breakdown history.
-- PREPARED via hand-written SQL (never `prisma migrate dev`/`diff` against
-- production — see the standing shadow-database incident rule; `migrate dev`
-- also refuses to run in this non-interactive environment). Purely
-- additive: one brand-new table, zero ALTER/DROP/RENAME on any existing
-- table or column. Intended to run once through `prisma migrate deploy`.

CREATE TABLE "amb_audience_breakdown_snapshots" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "window_name" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL,
    "breakdown_json" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amb_audience_breakdown_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "amb_audience_breakdown_snapshots_product_id_window_name_ca_idx" ON "amb_audience_breakdown_snapshots"("product_id", "window_name", "captured_at");

ALTER TABLE "amb_audience_breakdown_snapshots" ADD CONSTRAINT "amb_audience_breakdown_snapshots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
