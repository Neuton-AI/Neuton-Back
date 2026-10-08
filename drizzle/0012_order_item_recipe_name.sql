-- N-107: snapshot the recipe name onto order lines.
--
-- `order_items` stored only `recipe_id`, so every read re-joined `recipes` for
-- the label: renaming a recipe silently rewrote order history, and a recipe
-- with no row left took its order lines down with it.
-- The column is added nullable first so existing rows can be backfilled from
-- the catalog, then every read prefers the snapshot via
-- `coalesce(order_items.recipe_name, recipes.name)`.
ALTER TABLE "order_items" ADD COLUMN "recipe_name" text;--> statement-breakpoint
UPDATE "order_items" SET "recipe_name" = "recipes"."name" FROM "recipes" WHERE "order_items"."recipe_id" = "recipes"."id" AND "order_items"."recipe_name" IS NULL;
