-- B/84: recipe ingredients may be unlinked from inventory.
--
-- A recipe job must never create zero-cost orphan SKUs: when extraction names
-- something the shop does not stock, the row keeps the extracted `raw_name`
-- with a NULL `inventory_item_id` instead of forcing an inventory insert.
-- Backfills `raw_name` from the linked item name so the final SET NOT NULL
-- holds on tables that already have rows.
ALTER TABLE "recipe_ingredients" ALTER COLUMN "inventory_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "raw_name" text;--> statement-breakpoint
UPDATE "recipe_ingredients" SET "raw_name" = "inventory_items"."name" FROM "inventory_items" WHERE "recipe_ingredients"."inventory_item_id" = "inventory_items"."id" AND "recipe_ingredients"."raw_name" IS NULL;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ALTER COLUMN "raw_name" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_ingredients_recipe_id_raw_name_unique" ON "recipe_ingredients" USING btree ("recipe_id","raw_name");
