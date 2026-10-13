-- Add evidence and application state before touching existing quantities.
ALTER TABLE inventory_items ADD COLUMN measurement_status text NOT NULL DEFAULT 'ready';
ALTER TABLE inventory_items ADD COLUMN measurement_evidence jsonb;
ALTER TABLE inventory_items ALTER COLUMN current_quantity TYPE numeric(20,6);
ALTER TABLE inventory_items ALTER COLUMN average_unit_cost TYPE numeric(24,10);
ALTER TABLE inventory_items ALTER COLUMN last_unit_cost TYPE numeric(24,10);
-- A historical mixed-unit average cannot be inferred from its final balance.
UPDATE inventory_items SET measurement_status = 'legacy_reconciliation_required',
  measurement_evidence = jsonb_build_object('originalUnit', unit, 'quantity', current_quantity, 'average', average_unit_cost, 'reason', 'legacy_basis_unproven');
--> statement-breakpoint
ALTER TABLE recipes ALTER COLUMN yield_quantity DROP NOT NULL;
ALTER TABLE recipes ALTER COLUMN yield_quantity DROP DEFAULT;
ALTER TABLE recipes ALTER COLUMN yield_quantity TYPE numeric(20,6);
ALTER TABLE recipe_ingredients ALTER COLUMN quantity DROP NOT NULL;
ALTER TABLE recipe_ingredients ALTER COLUMN quantity TYPE numeric(20,6);
ALTER TABLE recipe_ingredients ALTER COLUMN unit DROP NOT NULL;
ALTER TABLE recipe_ingredients ADD COLUMN measurement_context jsonb;
DROP INDEX IF EXISTS recipe_ingredients_recipe_id_inventory_item_id_unique;
DROP INDEX IF EXISTS recipe_ingredients_recipe_id_raw_name_unique;
--> statement-breakpoint
ALTER TABLE general_prices ADD COLUMN offer_key text;
UPDATE general_prices SET offer_key = 'legacy:' || id::text;
ALTER TABLE general_prices ALTER COLUMN offer_key SET NOT NULL;
DROP INDEX IF EXISTS general_prices_normalized_name_unique;
CREATE UNIQUE INDEX general_prices_offer_key_unique ON general_prices(offer_key);
CREATE INDEX general_prices_normalized_name_idx ON general_prices(normalized_name);
ALTER TABLE general_prices ADD COLUMN chain_id text;
ALTER TABLE general_prices ADD COLUMN subchain_id text;
ALTER TABLE general_prices ADD COLUMN store_id text;
ALTER TABLE general_prices ADD COLUMN source_updated_at text;
ALTER TABLE general_prices ADD COLUMN measurement_status text NOT NULL DEFAULT 'unresolved';
ALTER TABLE general_prices ADD COLUMN measurement_reason text;
ALTER TABLE general_prices ADD COLUMN measurement_evidence jsonb;
ALTER TABLE general_prices ALTER COLUMN price_per_base_unit TYPE numeric(24,10);
--> statement-breakpoint
ALTER TABLE receipt_items ALTER COLUMN quantity TYPE numeric(20,6);
ALTER TABLE receipt_items ADD COLUMN code_chain text;
ALTER TABLE receipt_items ADD COLUMN package_quantity numeric(20,6);
ALTER TABLE receipt_items ADD COLUMN package_unit text;
ALTER TABLE receipt_items ADD COLUMN packages_per_purchase numeric(20,6);
ALTER TABLE receipt_items ADD COLUMN measurement_status text NOT NULL DEFAULT 'unresolved';
ALTER TABLE receipt_items ADD COLUMN measurement_reason text;
ALTER TABLE receipt_items ADD COLUMN measurement_evidence jsonb;
ALTER TABLE receipt_items ADD COLUMN normalized_quantity numeric(20,6);
ALTER TABLE receipt_items ADD COLUMN normalized_unit text;
ALTER TABLE receipt_items ADD COLUMN normalized_rate numeric(24,10);
ALTER TABLE receipt_items ADD COLUMN application_status text NOT NULL DEFAULT 'pending';
ALTER TABLE receipt_items ADD COLUMN applied_at timestamptz;
-- Never offer already-applied historical lines for deferred application.
UPDATE receipt_items i SET application_status = 'legacy_applied'
FROM receipts r WHERE r.id = i.receipt_id AND r.status = 'verified';
--> statement-breakpoint
ALTER TABLE orders ALTER COLUMN total_cost DROP NOT NULL;
ALTER TABLE orders ADD COLUMN currency text;
ALTER TABLE orders ADD COLUMN costing_status text NOT NULL DEFAULT 'unresolved';
UPDATE orders SET costing_status = 'legacy_snapshot';
ALTER TABLE order_items ALTER COLUMN unit_cost DROP NOT NULL;
ALTER TABLE order_items ALTER COLUMN unit_cost TYPE numeric(18,6);
ALTER TABLE order_items ADD COLUMN costing_snapshot jsonb;
--> statement-breakpoint
CREATE TABLE product_measurements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 product_key text NOT NULL, package_quantity numeric(20,6) NOT NULL,
 package_unit text NOT NULL, packages_per_purchase numeric(20,6) NOT NULL DEFAULT 1,
 evidence jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_measurements_shop_product_unique ON product_measurements(shop_id, product_key);
CREATE TABLE ingredient_conversions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 scope_key text NOT NULL, profile jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ingredient_conversions_shop_scope_unique ON ingredient_conversions(shop_id, scope_key);
ALTER TABLE product_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredient_conversions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_measurements, ingredient_conversions TO authenticated;
CREATE POLICY product_measurements_read ON product_measurements FOR SELECT TO authenticated USING (public.is_shop_member(shop_id));
CREATE POLICY product_measurements_write ON product_measurements FOR ALL TO authenticated USING (public.can_admin_shop(shop_id)) WITH CHECK (public.can_admin_shop(shop_id));
CREATE POLICY ingredient_conversions_read ON ingredient_conversions FOR SELECT TO authenticated USING (public.is_shop_member(shop_id));
CREATE POLICY ingredient_conversions_write ON ingredient_conversions FOR ALL TO authenticated USING (public.can_admin_shop(shop_id)) WITH CHECK (public.can_admin_shop(shop_id));
