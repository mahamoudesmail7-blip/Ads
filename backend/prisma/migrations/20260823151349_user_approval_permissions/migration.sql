-- Add the new approval/permissions columns, migrate the existing `active`
-- boolean into the new `status` string (true -> ACTIVE, false -> DISABLED)
-- so the current owner row's effective access is preserved exactly, then
-- drop `active`. No rows are deleted; only column shape changes.

ALTER TABLE "users" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "users" ADD COLUMN "date_of_birth" TEXT;
ALTER TABLE "users" ADD COLUMN "permissions" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "users" ADD COLUMN "is_owner" BOOLEAN NOT NULL DEFAULT false;

UPDATE "users" SET "status" = CASE WHEN "active" THEN 'ACTIVE' ELSE 'DISABLED' END;

ALTER TABLE "users" DROP COLUMN "active";
