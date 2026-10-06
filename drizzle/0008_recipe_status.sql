-- N-82: recipe status workflow + storage_path.
--
-- Existing recipes were created before the status workflow and are already
-- verified (they count in food cost). Backfill them so the new default
-- 'pending' only applies to newly uploaded recipes.
ALTER TABLE "recipes" ADD COLUMN "storage_path" text;
--> statement-breakpoint
UPDATE "recipes" SET "status" = 'verified' WHERE "status" = 'unverified';
--> statement-breakpoint
ALTER TABLE "recipes" ALTER COLUMN "status" SET DEFAULT 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_shop_id_storage_path_unique"
  ON "recipes" ("shop_id", "storage_path")
  WHERE "storage_path" IS NOT NULL;