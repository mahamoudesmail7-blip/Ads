-- ROLLBACK for 20261013120000_operator_v2_views (AI Operator V2 saved views + selection snapshots).
-- Not a Prisma migration (Prisma only reads migration.sql): run it by hand ONLY if the owner decides to roll back, e.g.
--   npx prisma db execute --url "$DIRECT_DATABASE_URL" --file prisma/migrations/20261013120000_operator_v2_views/rollback.sql
-- What it removes: the two NEW tables and nothing else. No other table, column, index or constraint is touched (the migration added none).
-- What is lost: users' saved views and 30-minute selection snapshots (cheap to recreate). Export first if anyone cares:
--   SELECT * FROM "amb_operator_saved_views";
-- The code does not need the tables to be present: with the tables missing the V2 views/snapshot endpoints answer 503 V2_TABLES_MISSING and the rest of V2 (home, campaigns, export, review) keeps working,
-- and the V2 interface is OFF by default anyway (feature flag opx.v2) — switching the flag off is the instant, data-free rollback. Prefer that; use this file only to also remove the tables.

DROP TABLE IF EXISTS "amb_operator_selection_snapshots";
DROP TABLE IF EXISTS "amb_operator_saved_views";

-- Only if `prisma migrate deploy` recorded the migration and you want it applied again later, forget the record as well (otherwise Prisma will consider it applied):
-- DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261013120000_operator_v2_views';
