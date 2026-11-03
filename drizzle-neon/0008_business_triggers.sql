GRANT SELECT(id,target_profit_margin,hourly_labor_cost) ON public.shops TO neuton_maintenance;
GRANT SELECT(id,shop_id,is_active) ON public.recipes TO neuton_maintenance;
GRANT SELECT(shop_id,recipe_id,inventory_item_id,general_price_id) ON public.recipe_ingredients TO neuton_maintenance;
GRANT SELECT,INSERT,UPDATE ON public.document_versions TO neuton_maintenance;
CREATE POLICY maintenance_shops_read ON public.shops FOR SELECT TO neuton_maintenance USING(true);
CREATE POLICY maintenance_recipes_read ON public.recipes FOR SELECT TO neuton_maintenance USING(true);
CREATE POLICY maintenance_ingredients_read ON public.recipe_ingredients FOR SELECT TO neuton_maintenance USING(true);
CREATE POLICY maintenance_versions ON public.document_versions TO neuton_maintenance USING(true) WITH CHECK(true);
CREATE FUNCTION app_private.set_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.updated_at=statement_timestamp(); RETURN NEW; END $$;
REVOKE ALL ON FUNCTION app_private.set_updated_at() FROM PUBLIC;
CREATE TRIGGER shops_updated_at BEFORE UPDATE ON public.shops FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();
CREATE TRIGGER inventory_items_updated_at BEFORE UPDATE ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();
CREATE TRIGGER recipes_updated_at BEFORE UPDATE ON public.recipes FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();
CREATE TRIGGER receipts_updated_at BEFORE UPDATE ON public.receipts FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON auth_private.users FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();
CREATE FUNCTION app_private.track_document_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  row_data jsonb;
  version_ms bigint;
  is_deleted boolean;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  -- A shop cascade removes its entire namespace, including its version records.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.shops WHERE id = (row_data->>'shop_id')::uuid) THEN
    RETURN NULL;
  END IF;
  version_ms := COALESCE(NULLIF(current_setting('neuton.sync_version', true), '')::bigint,
    floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint);
  is_deleted := TG_OP = 'DELETE' OR (TG_ARGV[0] = 'recipe' AND row_data->>'is_active' = 'false')
    OR (TG_ARGV[0] = 'order' AND row_data->>'deleted_at' IS NOT NULL);
  INSERT INTO public.document_versions(shop_id, kind, id, updated_at, deleted)
    VALUES ((row_data->>'shop_id')::uuid, TG_ARGV[0], (row_data->>'id')::uuid, version_ms, is_deleted)
    ON CONFLICT (shop_id, kind, id) DO UPDATE
    SET updated_at = greatest(public.document_versions.updated_at + 1, EXCLUDED.updated_at), deleted = EXCLUDED.deleted;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER receipt_sync_version AFTER INSERT OR UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.track_document_version('receipt');
CREATE TRIGGER recipe_sync_version AFTER INSERT OR UPDATE OR DELETE ON public.recipes
  FOR EACH ROW EXECUTE FUNCTION app_private.track_document_version('recipe');
CREATE TRIGGER order_sync_version AFTER INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION app_private.track_document_version('order');
--> statement-breakpoint



--> statement-breakpoint
-- Costing is part of a recipe response. Changes to its inputs must invalidate
-- that snapshot even when the recipe's own row has not been edited.
CREATE FUNCTION app_private.touch_recipe_sync_version(target_shop uuid, target_recipe uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  same_edit boolean;
  version_ms bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.recipes WHERE id=target_recipe AND shop_id=target_shop) THEN RETURN; END IF;
  same_edit := coalesce(current_setting('neuton.sync_document_id', true), '') = target_recipe::text;
  version_ms := CASE WHEN same_edit THEN current_setting('neuton.sync_version')::bigint
    ELSE floor(extract(epoch FROM clock_timestamp())*1000)::bigint END;
  UPDATE public.document_versions
    SET updated_at=greatest(updated_at + CASE WHEN same_edit THEN 0 ELSE 1 END, version_ms)
    WHERE shop_id=target_shop AND kind='recipe' AND id=target_recipe AND NOT deleted;
END $$;
--> statement-breakpoint
CREATE FUNCTION app_private.track_recipe_sync_dependencies() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  row_data jsonb;
  dependent record;
BEGIN
  row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='recipe_ingredients' THEN
    PERFORM app_private.touch_recipe_sync_version((row_data->>'shop_id')::uuid, (row_data->>'recipe_id')::uuid);
    IF TG_OP='UPDATE' AND OLD.recipe_id IS DISTINCT FROM NEW.recipe_id THEN
      PERFORM app_private.touch_recipe_sync_version(OLD.shop_id, OLD.recipe_id);
    END IF;
  ELSIF TG_TABLE_NAME='inventory_items' THEN
    FOR dependent IN SELECT DISTINCT shop_id, recipe_id FROM public.recipe_ingredients WHERE inventory_item_id=(row_data->>'id')::uuid LOOP
      PERFORM app_private.touch_recipe_sync_version(dependent.shop_id, dependent.recipe_id);
    END LOOP;
  ELSIF TG_TABLE_NAME='general_prices' THEN
    FOR dependent IN SELECT DISTINCT shop_id, recipe_id FROM public.recipe_ingredients WHERE general_price_id=(row_data->>'id')::uuid LOOP
      PERFORM app_private.touch_recipe_sync_version(dependent.shop_id, dependent.recipe_id);
    END LOOP;
  ELSE
    IF OLD.target_profit_margin IS NOT DISTINCT FROM NEW.target_profit_margin
      AND OLD.hourly_labor_cost IS NOT DISTINCT FROM NEW.hourly_labor_cost THEN RETURN NULL; END IF;
    FOR dependent IN SELECT shop_id, id AS recipe_id FROM public.recipes WHERE shop_id=NEW.id AND is_active LOOP
      PERFORM app_private.touch_recipe_sync_version(dependent.shop_id, dependent.recipe_id);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER recipe_ingredients_sync_dependencies AFTER INSERT OR UPDATE OR DELETE ON public.recipe_ingredients
  FOR EACH ROW EXECUTE FUNCTION app_private.track_recipe_sync_dependencies();
CREATE TRIGGER inventory_sync_dependencies AFTER UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION app_private.track_recipe_sync_dependencies();
CREATE TRIGGER general_prices_sync_dependencies AFTER UPDATE ON general_prices
  FOR EACH ROW EXECUTE FUNCTION app_private.track_recipe_sync_dependencies();
CREATE TRIGGER shop_pricing_sync_dependencies AFTER UPDATE ON public.shops
  FOR EACH ROW EXECUTE FUNCTION app_private.track_recipe_sync_dependencies();

-- Notifications are hints, delivered on commit. No edit history is stored.
CREATE FUNCTION app_private.notify_document_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_notify('neuton_document_changes', NEW.shop_id::text);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER document_version_notification AFTER INSERT OR UPDATE ON public.document_versions
  FOR EACH ROW EXECUTE FUNCTION app_private.notify_document_change();

GRANT SELECT,INSERT,UPDATE ON public.general_prices TO neuton_maintenance;
CREATE FUNCTION app_private.upsert_general_price(p_raw_name text,p_sku text,p_material text,
p_raw_unit text,p_unit text,p_base_unit text,p_amount numeric,p_cost numeric) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE caller text:=coalesce(nullif(current_setting('role',true),'none'),session_user::text); result uuid;
BEGIN
 IF NOT ((caller='neuton_app' AND app_private.shop_access(app_private.context_uuid('neuton.shop_id'),true))
 OR (caller='neuton_worker' AND (app_private.worker_access(app_private.context_uuid('neuton.shop_id'),'recipe')
 OR app_private.worker_access(app_private.context_uuid('neuton.shop_id'),'inventory')))) THEN
  RAISE EXCEPTION 'Global price write forbidden' USING ERRCODE='42501';
 END IF;
 IF p_raw_name IS NULL OR p_material IS NULL OR length(p_raw_name)>2000 OR length(p_material)>2000
 OR length(p_sku)>200 OR length(p_raw_unit)>100 OR length(p_unit)>100 OR length(p_base_unit)>100
 OR p_amount<=0 OR p_cost<0 OR p_amount::text IN ('NaN','Infinity','-Infinity')
 OR p_cost::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid price input' USING ERRCODE='23514'; END IF;
 INSERT INTO public.general_prices(raw_name,sku,raw_material_name,raw_src_unit,src_unit,base_unit,base_unit_amount,base_unit_cost)
 VALUES(p_raw_name,p_sku,p_material,p_raw_unit,p_unit,p_base_unit,p_amount,p_cost)
 ON CONFLICT(raw_material_name,sku) DO UPDATE SET raw_name=excluded.raw_name,raw_src_unit=excluded.raw_src_unit,
 src_unit=excluded.src_unit,base_unit=excluded.base_unit,base_unit_amount=excluded.base_unit_amount,base_unit_cost=excluded.base_unit_cost
 RETURNING id INTO result;
 RETURN result;
END $$;
GRANT CREATE ON SCHEMA app_private TO neuton_maintenance;
DO $$ DECLARE fn record; BEGIN
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='app_private' AND p.proname IN ('track_document_version','touch_recipe_sync_version',
 'track_recipe_sync_dependencies','notify_document_change','upsert_general_price') LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO neuton_maintenance',fn.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA app_private FROM neuton_maintenance;
GRANT EXECUTE ON FUNCTION app_private.upsert_general_price(text,text,text,text,text,text,numeric,numeric) TO neuton_app,neuton_worker;
