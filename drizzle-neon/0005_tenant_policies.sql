-- Current services permit members to read and verify orders, but creation and
-- edits require owner/admin. Verification gets a narrow routine in 0009.
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['categories','inventory_items','recipes','recipe_ingredients',
 'receipts','receipt_items','orders','order_items','product_measurements','ingredient_conversions'] LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO neuton_app',relation);
  EXECUTE format('CREATE POLICY tenant_read ON public.%I FOR SELECT TO neuton_app USING(app_private.shop_access(shop_id))',relation);
  EXECUTE format('CREATE POLICY tenant_insert ON public.%I FOR INSERT TO neuton_app WITH CHECK(app_private.shop_access(shop_id,true))',relation);
  EXECUTE format('CREATE POLICY tenant_update ON public.%I FOR UPDATE TO neuton_app USING(app_private.shop_access(shop_id,true)) WITH CHECK(app_private.shop_access(shop_id,true))',relation);
  EXECUTE format('CREATE POLICY tenant_delete ON public.%I FOR DELETE TO neuton_app USING(app_private.shop_access(shop_id,true))',relation);
 END LOOP;
END $$;
GRANT SELECT ON public.general_prices TO neuton_app,neuton_worker;
