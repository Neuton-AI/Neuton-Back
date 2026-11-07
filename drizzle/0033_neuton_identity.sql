ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_id_users_id_fk;
--> statement-breakpoint
-- Preserve historical profiles and shop records without creating accounts for them.
-- NOT VALID still enforces the FK for every new or changed profile ID.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_users_id_fk
  FOREIGN KEY (id) REFERENCES public.users(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p.id)
  ) THEN
    ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_id_users_id_fk;
  END IF;
END $$;
--> statement-breakpoint
DROP POLICY IF EXISTS "shops_select_own" ON public.shops;
DROP POLICY IF EXISTS "shops_insert_own" ON public.shops;
DROP POLICY IF EXISTS "shops_admin_update" ON public.shops;
DROP POLICY IF EXISTS "shops_owner_delete" ON public.shops;
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
DROP POLICY IF EXISTS "shop_members_select_own" ON public.shop_members;
DROP POLICY IF EXISTS "shop_members_admin_write" ON public.shop_members;
DROP POLICY IF EXISTS "audit_logs_select_admin" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_insert_member" ON public.audit_logs;
DROP POLICY IF EXISTS "categories_shop_isolation" ON public.categories;
DROP POLICY IF EXISTS "inventory_items_shop_isolation" ON public.inventory_items;
DROP POLICY IF EXISTS "recipes_shop_isolation" ON public.recipes;
DROP POLICY IF EXISTS "recipe_ingredients_shop_isolation" ON public.recipe_ingredients;
DROP POLICY IF EXISTS "receipts_shop_isolation" ON public.receipts;
DROP POLICY IF EXISTS "receipt_items_shop_isolation" ON public.receipt_items;
DROP POLICY IF EXISTS "orders_shop_isolation" ON public.orders;
DROP POLICY IF EXISTS "order_items_shop_isolation" ON public.order_items;
DROP POLICY IF EXISTS "product_measurements_read" ON public.product_measurements;
DROP POLICY IF EXISTS "product_measurements_write" ON public.product_measurements;
DROP POLICY IF EXISTS "ingredient_conversions_read" ON public.ingredient_conversions;
DROP POLICY IF EXISTS "ingredient_conversions_write" ON public.ingredient_conversions;
DROP POLICY IF EXISTS "media_uploads_shop_read" ON public.media_uploads;
DROP FUNCTION IF EXISTS public.can_admin_shop(uuid);
DROP FUNCTION IF EXISTS public.shop_role(uuid);
DROP FUNCTION IF EXISTS public.is_shop_member(uuid);
--> statement-breakpoint
-- Supabase-hosted databases may grant access to newly created public tables by default.
DO $$
DECLARE
  api_role text;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
  LOOP
    EXECUTE format(
      'REVOKE ALL ON public.users, public.profiles, public.shops, public.shop_members,
        public.audit_logs, public.categories, public.inventory_items, public.recipes,
        public.recipe_ingredients, public.receipts, public.receipt_items, public.orders,
        public.order_items, public.product_measurements, public.ingredient_conversions,
        public.media_uploads, public.storage_object_deletions FROM %I',
      api_role
    );
  END LOOP;
END $$;
