-- Reconcile the current schema with the older measurement/costing deployment.
-- Applied migrations and their ledger checksums remain unchanged.
-- Before applying, back up public schema/data. The obsolete measurement fields
-- are removed; duplicate global prices keep the newest fetched offer, with all
-- ingredient links redirected. Price-per-base-unit rounds to four decimals.
-- The runner executes this entire file and its ledger insert in one transaction.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE public.inventory_items, public.recipes, public.recipe_ingredients,
  public.general_prices, public.receipt_items, public.orders, public.order_items
  IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

-- Reject unexpected nulls or precision loss rather than invent historical data.
DO $$
DECLARE
  item record;
  incompatible boolean;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('inventory_items', 'current_quantity', 12, 3),
    ('inventory_items', 'last_unit_cost', 12, 4),
    ('inventory_items', 'average_unit_cost', 12, 4),
    ('general_prices', 'package_quantity', 12, 3),
    ('receipt_items', 'quantity', 12, 3),
    ('recipe_ingredients', 'quantity', 12, 3),
    ('recipes', 'yield_quantity', 12, 3),
    ('order_items', 'unit_cost', 10, 2)
  ) AS limits(table_name, column_name, precision_digits, scale_digits)
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I WHERE %I <> round(%I, %s) OR abs(%I) >= power(10::numeric, %s))',
      item.table_name, item.column_name, item.column_name, item.scale_digits,
      item.column_name, item.precision_digits - item.scale_digits
    ) INTO incompatible;
    IF incompatible THEN
      RAISE EXCEPTION 'Cannot safely narrow %.%: values would round or overflow', item.table_name, item.column_name;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.recipes WHERE yield_quantity IS NULL)
    OR EXISTS (SELECT 1 FROM public.recipe_ingredients WHERE quantity IS NULL OR unit IS NULL)
    OR EXISTS (SELECT 1 FROM public.order_items WHERE unit_cost IS NULL)
    OR EXISTS (SELECT 1 FROM public.orders WHERE total_cost IS NULL) THEN
    RAISE EXCEPTION 'Required historical values are missing; reconcile before applying';
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE public.receipt_items
  ADD COLUMN raw_src_unit text,
  ADD COLUMN src_unit_amount numeric(12, 3),
  ADD COLUMN base_unit text,
  ADD COLUMN base_unit_amount numeric(12, 3);--> statement-breakpoint

-- Preserve extracted units verbatim; do not guess conversions for old receipts.
UPDATE public.receipt_items SET raw_src_unit = src_unit WHERE src_unit IS NOT NULL;--> statement-breakpoint

WITH ranked AS (
  SELECT id, first_value(id) OVER (
    PARTITION BY normalized_name ORDER BY fetched_at DESC, updated_at DESC, id DESC
  ) AS kept_id FROM public.general_prices
)
UPDATE public.recipe_ingredients AS ingredient
SET general_price_id = ranked.kept_id
FROM ranked WHERE ingredient.general_price_id = ranked.id AND ranked.id <> ranked.kept_id;--> statement-breakpoint

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY normalized_name ORDER BY fetched_at DESC, updated_at DESC, id DESC
  ) AS position FROM public.general_prices
)
DELETE FROM public.general_prices AS price USING ranked
WHERE price.id = ranked.id AND ranked.position > 1;--> statement-breakpoint

ALTER TABLE public.inventory_items
  ALTER COLUMN current_quantity TYPE numeric(12, 3),
  ALTER COLUMN last_unit_cost TYPE numeric(12, 4),
  ALTER COLUMN average_unit_cost TYPE numeric(12, 4),
  DROP COLUMN IF EXISTS currency,
  DROP COLUMN IF EXISTS measurement_status,
  DROP COLUMN IF EXISTS measurement_evidence;--> statement-breakpoint

ALTER TABLE public.recipes
  ALTER COLUMN yield_quantity TYPE numeric(12, 3),
  ALTER COLUMN yield_quantity SET DEFAULT '1',
  ALTER COLUMN yield_quantity SET NOT NULL;--> statement-breakpoint

ALTER TABLE public.recipe_ingredients
  ALTER COLUMN quantity TYPE numeric(12, 3),
  ALTER COLUMN quantity SET NOT NULL,
  ALTER COLUMN unit SET NOT NULL,
  DROP COLUMN IF EXISTS measurement_context;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS recipe_ingredients_recipe_id_inventory_item_id_unique
  ON public.recipe_ingredients (recipe_id, inventory_item_id);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS recipe_ingredients_recipe_id_raw_name_unique
  ON public.recipe_ingredients (recipe_id, raw_name);--> statement-breakpoint

ALTER TABLE public.receipt_items ALTER COLUMN quantity TYPE numeric(12, 3);--> statement-breakpoint

ALTER TABLE public.general_prices
  ALTER COLUMN package_quantity TYPE numeric(12, 3),
  ALTER COLUMN price_per_base_unit TYPE numeric(12, 4) USING round(price_per_base_unit, 4),
  DROP COLUMN IF EXISTS offer_key,
  DROP COLUMN IF EXISTS chain_id,
  DROP COLUMN IF EXISTS subchain_id,
  DROP COLUMN IF EXISTS store_id,
  DROP COLUMN IF EXISTS source_updated_at,
  DROP COLUMN IF EXISTS measurement_status,
  DROP COLUMN IF EXISTS measurement_reason,
  DROP COLUMN IF EXISTS measurement_evidence;--> statement-breakpoint

DROP INDEX IF EXISTS public.general_prices_normalized_name_idx;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS general_prices_normalized_name_unique
  ON public.general_prices (normalized_name);--> statement-breakpoint

ALTER TABLE public.orders
  ALTER COLUMN total_cost SET NOT NULL,
  DROP COLUMN IF EXISTS currency,
  DROP COLUMN IF EXISTS costing_status;--> statement-breakpoint

ALTER TABLE public.order_items
  ALTER COLUMN unit_cost TYPE numeric(10, 2),
  ALTER COLUMN unit_cost SET NOT NULL,
  DROP COLUMN IF EXISTS currency,
  DROP COLUMN IF EXISTS costing_snapshot;
