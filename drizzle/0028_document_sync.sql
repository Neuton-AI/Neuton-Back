CREATE TABLE document_versions (
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('receipt', 'recipe', 'order')),
  id uuid NOT NULL,
  updated_at bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (shop_id, kind, id)
);
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE document_mutations (
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  request jsonb NOT NULL,
  response jsonb,
  status integer NOT NULL DEFAULT 200,
  PRIMARY KEY (shop_id, id)
);
ALTER TABLE document_mutations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION track_document_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb;
  version_ms bigint;
  is_deleted boolean;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  -- A shop cascade removes its entire namespace, including its version records.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM shops WHERE id = (row_data->>'shop_id')::uuid) THEN
    RETURN NULL;
  END IF;
  version_ms := COALESCE(NULLIF(current_setting('neuton.sync_version', true), '')::bigint,
    floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint);
  is_deleted := TG_OP = 'DELETE' OR (TG_ARGV[0] = 'recipe' AND row_data->>'is_active' = 'false')
    OR (TG_ARGV[0] = 'order' AND row_data->>'deleted_at' IS NOT NULL);
  INSERT INTO document_versions(shop_id, kind, id, updated_at, deleted)
    VALUES ((row_data->>'shop_id')::uuid, TG_ARGV[0], (row_data->>'id')::uuid, version_ms, is_deleted)
    ON CONFLICT (shop_id, kind, id) DO UPDATE
    SET updated_at = greatest(document_versions.updated_at + 1, EXCLUDED.updated_at), deleted = EXCLUDED.deleted;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER receipt_sync_version AFTER INSERT OR UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION track_document_version('receipt');
CREATE TRIGGER recipe_sync_version AFTER INSERT OR UPDATE OR DELETE ON recipes
  FOR EACH ROW EXECUTE FUNCTION track_document_version('recipe');
CREATE TRIGGER order_sync_version AFTER INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION track_document_version('order');
--> statement-breakpoint
INSERT INTO document_versions SELECT shop_id, 'receipt', id, floor(extract(epoch FROM updated_at)*1000)::bigint, false FROM receipts;
INSERT INTO document_versions SELECT shop_id, 'recipe', id, floor(extract(epoch FROM updated_at)*1000)::bigint, NOT is_active FROM recipes;
INSERT INTO document_versions SELECT shop_id, 'order', id, floor(extract(epoch FROM coalesce(deleted_at, created_at))*1000)::bigint, deleted_at IS NOT NULL FROM orders;
--> statement-breakpoint
-- Costing is part of a recipe response. Changes to its inputs must invalidate
-- that snapshot even when the recipe's own row has not been edited.
CREATE FUNCTION touch_recipe_sync_version(target_shop uuid, target_recipe uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  same_edit boolean;
  version_ms bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM recipes WHERE id=target_recipe AND shop_id=target_shop) THEN RETURN; END IF;
  same_edit := coalesce(current_setting('neuton.sync_document_id', true), '') = target_recipe::text;
  version_ms := CASE WHEN same_edit THEN current_setting('neuton.sync_version')::bigint
    ELSE floor(extract(epoch FROM clock_timestamp())*1000)::bigint END;
  UPDATE document_versions
    SET updated_at=greatest(updated_at + CASE WHEN same_edit THEN 0 ELSE 1 END, version_ms)
    WHERE shop_id=target_shop AND kind='recipe' AND id=target_recipe AND NOT deleted;
END $$;
--> statement-breakpoint
CREATE FUNCTION track_recipe_sync_dependencies() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb;
  dependent record;
BEGIN
  row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='recipe_ingredients' THEN
    PERFORM touch_recipe_sync_version((row_data->>'shop_id')::uuid, (row_data->>'recipe_id')::uuid);
    IF TG_OP='UPDATE' AND OLD.recipe_id IS DISTINCT FROM NEW.recipe_id THEN
      PERFORM touch_recipe_sync_version(OLD.shop_id, OLD.recipe_id);
    END IF;
  ELSIF TG_TABLE_NAME='inventory_items' THEN
    FOR dependent IN SELECT DISTINCT shop_id, recipe_id FROM recipe_ingredients WHERE inventory_item_id=(row_data->>'id')::uuid LOOP
      PERFORM touch_recipe_sync_version(dependent.shop_id, dependent.recipe_id);
    END LOOP;
  ELSIF TG_TABLE_NAME='general_prices' THEN
    FOR dependent IN SELECT DISTINCT shop_id, recipe_id FROM recipe_ingredients WHERE general_price_id=(row_data->>'id')::uuid LOOP
      PERFORM touch_recipe_sync_version(dependent.shop_id, dependent.recipe_id);
    END LOOP;
  ELSE
    IF OLD.target_profit_margin IS NOT DISTINCT FROM NEW.target_profit_margin
      AND OLD.hourly_labor_cost IS NOT DISTINCT FROM NEW.hourly_labor_cost THEN RETURN NULL; END IF;
    FOR dependent IN SELECT shop_id, id AS recipe_id FROM recipes WHERE shop_id=NEW.id AND is_active LOOP
      PERFORM touch_recipe_sync_version(dependent.shop_id, dependent.recipe_id);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER recipe_ingredients_sync_dependencies AFTER INSERT OR UPDATE OR DELETE ON recipe_ingredients
  FOR EACH ROW EXECUTE FUNCTION track_recipe_sync_dependencies();
CREATE TRIGGER inventory_sync_dependencies AFTER UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION track_recipe_sync_dependencies();
CREATE TRIGGER general_prices_sync_dependencies AFTER UPDATE ON general_prices
  FOR EACH ROW EXECUTE FUNCTION track_recipe_sync_dependencies();
CREATE TRIGGER shop_pricing_sync_dependencies AFTER UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION track_recipe_sync_dependencies();
