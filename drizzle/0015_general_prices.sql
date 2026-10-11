-- #123: general_prices cache table + link from recipe_ingredients.
--
-- An unlinked recipe ingredient (inventory_item_id NULL, i.e. a material the
-- shop does not stock) had no price home, so cost calc silently fell back to 0
-- (src/worker.ts) and underpriced recipes. `general_prices` is a *global* -- not
-- per-shop -- cache of supermarket prices resolved from the Israeli PriceFull
-- feeds that such a line can point at.
--
-- Global on purpose: the same product's price is shared by every shop. The
-- worker owns the rows and refreshes them; shops only read. `normalized_name`
-- is the lookup key and unique; `barcode` is indexed for scan-based matching.
--
-- `recipe_ingredients` may link to EITHER an inventory item (shop-specific,
-- authoritative) OR a general price (external fallback), never both. The check
-- constraint allows at most one; both null means the line is truly unpriced.
-- A general price removed from the cache simply unlinks the line (`set null`),
-- it never deletes or blocks the ingredient.
--
-- Rollback impact: both changes are additive and non-destructive. Rolling back
-- drops `recipe_ingredients.general_price_id` (losing ingredient -> price links)
-- and the `general_prices` table (losing the cached prices, re-fetchable).
-- No existing row is read or rewritten by the forward migration.
CREATE TABLE "general_prices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "normalized_name" text NOT NULL,
  "barcode" text,
  "name" text NOT NULL,
  "manufacturer" text,
  "chain" text NOT NULL,
  "price_ils" numeric(12, 2) NOT NULL,
  "package_quantity" numeric(12, 3),
  "package_unit" text,
  "price_per_base_unit" numeric(12, 4),
  "source_url" text,
  "fetched_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "general_prices_normalized_name_unique" ON "general_prices" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "general_prices_barcode_idx" ON "general_prices" USING btree ("barcode");--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "general_price_id" uuid;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_general_price_id_general_prices_id_fk" FOREIGN KEY ("general_price_id") REFERENCES "public"."general_prices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_price_link_check" CHECK (num_nonnulls("inventory_item_id", "general_price_id") <= 1);
