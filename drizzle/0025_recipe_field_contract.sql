ALTER TABLE "recipe_ingredients" RENAME COLUMN "search_able_name" TO "raw_material_name";
--> statement-breakpoint
ALTER TABLE "recipe_ingredients" RENAME COLUMN "unit" TO "raw_src_unit";
--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "base_unit" text;
ALTER TABLE "recipe_ingredients" ADD COLUMN "base_unit_amount" numeric(24,3);
--> statement-breakpoint
-- Only exact metric/count units have an unambiguous historical conversion.
UPDATE recipe_ingredients SET
  base_unit = CASE raw_src_unit WHEN 'kg' THEN 'g' WHEN 'g' THEN 'g' WHEN 'l' THEN 'ml' WHEN 'ml' THEN 'ml' WHEN 'unit' THEN 'unit' WHEN 'each' THEN 'unit' END,
  base_unit_amount = CASE raw_src_unit WHEN 'kg' THEN quantity * 1000 WHEN 'g' THEN quantity WHEN 'l' THEN quantity * 1000 WHEN 'ml' THEN quantity WHEN 'unit' THEN quantity WHEN 'each' THEN quantity END
WHERE quantity > 0;
--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "steps" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- Preserve legacy instructions byte-for-byte in one ordered step; do not guess boundaries.
UPDATE recipes SET steps = jsonb_build_array(jsonb_build_object('stepNumber', 1, 'instruction', instructions))
WHERE instructions IS NOT NULL AND instructions <> '';
--> statement-breakpoint
ALTER TABLE "recipes" DROP COLUMN "instructions";
--> statement-breakpoint
DROP INDEX "general_prices_normalized_name_unique";
DROP INDEX "general_prices_barcode_idx";
--> statement-breakpoint
ALTER TABLE "general_prices" RENAME COLUMN "name" TO "raw_name";
ALTER TABLE "general_prices" RENAME COLUMN "barcode" TO "sku";
ALTER TABLE "general_prices" RENAME COLUMN "normalized_name" TO "raw_material_name";
ALTER TABLE "general_prices" RENAME COLUMN "package_unit" TO "raw_src_unit";
--> statement-breakpoint
ALTER TABLE "general_prices" ADD COLUMN "src_unit" text;
ALTER TABLE "general_prices" ADD COLUMN "base_unit" text;
ALTER TABLE "general_prices" ADD COLUMN "base_unit_amount" numeric(24,3);
ALTER TABLE "general_prices" ADD COLUMN "base_unit_cost" numeric(18,6);
--> statement-breakpoint
-- Package quantity and a known physical unit support conversion. Legacy per-base
-- price has no proven basis, so derive only from the actual package price.
UPDATE general_prices SET
  src_unit = raw_src_unit,
  base_unit = CASE raw_src_unit WHEN 'kg' THEN 'g' WHEN 'g' THEN 'g' WHEN 'l' THEN 'ml' WHEN 'ml' THEN 'ml' WHEN 'unit' THEN 'unit' WHEN 'each' THEN 'unit' END,
  base_unit_amount = CASE raw_src_unit WHEN 'kg' THEN package_quantity * 1000 WHEN 'g' THEN package_quantity WHEN 'l' THEN package_quantity * 1000 WHEN 'ml' THEN package_quantity WHEN 'unit' THEN package_quantity WHEN 'each' THEN package_quantity END
WHERE package_quantity > 0;
--> statement-breakpoint
UPDATE general_prices SET base_unit_cost = price_ils / base_unit_amount
WHERE base_unit_amount > 0 AND price_ils > 0
  AND round(price_ils / base_unit_amount, 6) > 0
  AND price_ils / base_unit_amount < 1000000000000;
--> statement-breakpoint
ALTER TABLE "general_prices"
  DROP COLUMN "manufacturer", DROP COLUMN "chain", DROP COLUMN "price_ils",
  DROP COLUMN "package_quantity", DROP COLUMN "price_per_base_unit",
  DROP COLUMN "source_url", DROP COLUMN "fetched_at", DROP COLUMN "updated_at";
--> statement-breakpoint
CREATE UNIQUE INDEX "general_prices_material_sku_unique" ON "general_prices" ("raw_material_name", "sku");
CREATE INDEX "general_prices_sku_idx" ON "general_prices" ("sku");
