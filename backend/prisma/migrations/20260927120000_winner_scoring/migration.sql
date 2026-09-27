-- Winner Discovery Engine Slice 1: additive column only, no data loss risk.
ALTER TABLE "winner_products" ADD COLUMN "score_breakdown_json" TEXT;
