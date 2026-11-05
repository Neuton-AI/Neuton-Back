-- Auth linkage, timestamp maintenance, and tenant Row Level Security.
-- Hand-written because it references Supabase-managed objects (auth.users,
-- auth.uid()) and helper functions that drizzle-kit does not model.
--
-- Apply migrations with `npm run db:migrate`, which applies every *.sql file in
-- this folder in filename order and records it in public.__neuton_migrations.
-- `npx drizzle-kit migrate` also understands this file (it is registered in
-- drizzle/meta/_journal.json with a matching snapshot), but the two runners
-- keep separate ledgers -- pick one per database and do not interleave them.

-- ---------------------------------------------------------------------------
-- 1. Link profiles to Supabase's native auth.users
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_id_users_id_fk'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_id_users_id_fk
      FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. updated_at maintenance
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shops_set_updated_at ON public.shops;
CREATE TRIGGER shops_set_updated_at
  BEFORE UPDATE ON public.shops
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS inventory_items_set_updated_at ON public.inventory_items;
CREATE TRIGGER inventory_items_set_updated_at
  BEFORE UPDATE ON public.inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS recipes_set_updated_at ON public.recipes;
CREATE TRIGGER recipes_set_updated_at
  BEFORE UPDATE ON public.recipes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS receipts_set_updated_at ON public.receipts;
CREATE TRIGGER receipts_set_updated_at
  BEFORE UPDATE ON public.receipts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Membership helpers (SECURITY DEFINER avoids RLS recursion on shop_members)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_shop_member(target_shop_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.shop_members m
    WHERE m.shop_id = target_shop_id
      AND m.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.shop_role(target_shop_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.role
  FROM public.shop_members m
  WHERE m.shop_id = target_shop_id
    AND m.user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.can_admin_shop(target_shop_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(public.shop_role(target_shop_id) IN ('owner', 'admin'), false);
$$;

REVOKE ALL ON FUNCTION public.is_shop_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shop_role(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_admin_shop(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_shop_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shop_role(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_admin_shop(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Row Level Security: tenant tables follow the documented isolation pattern
-- ---------------------------------------------------------------------------

ALTER TABLE public.shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

-- shops ----------------------------------------------------------------------
DROP POLICY IF EXISTS "shops_select_own" ON public.shops;
CREATE POLICY "shops_select_own" ON public.shops
  FOR SELECT TO authenticated
  USING (public.is_shop_member(id));

DROP POLICY IF EXISTS "shops_insert_own" ON public.shops;
CREATE POLICY "shops_insert_own" ON public.shops
  FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "shops_admin_update" ON public.shops;
CREATE POLICY "shops_admin_update" ON public.shops
  FOR UPDATE TO authenticated
  USING (public.can_admin_shop(id))
  WITH CHECK (public.can_admin_shop(id));

DROP POLICY IF EXISTS "shops_owner_delete" ON public.shops;
CREATE POLICY "shops_owner_delete" ON public.shops
  FOR DELETE TO authenticated
  USING (public.shop_role(id) = 'owner');

-- profiles -------------------------------------------------------------------
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.shop_members mine
      JOIN public.shop_members theirs ON theirs.shop_id = mine.shop_id
      WHERE mine.user_id = auth.uid() AND theirs.user_id = profiles.id
    )
  );

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- shop_members ---------------------------------------------------------------
DROP POLICY IF EXISTS "shop_members_select_own" ON public.shop_members;
CREATE POLICY "shop_members_select_own" ON public.shop_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.can_admin_shop(shop_id));

DROP POLICY IF EXISTS "shop_members_admin_write" ON public.shop_members;
CREATE POLICY "shop_members_admin_write" ON public.shop_members
  FOR ALL TO authenticated
  USING (public.can_admin_shop(shop_id))
  WITH CHECK (public.can_admin_shop(shop_id));

-- audit_logs -----------------------------------------------------------------
DROP POLICY IF EXISTS "audit_logs_select_admin" ON public.audit_logs;
CREATE POLICY "audit_logs_select_admin" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (public.can_admin_shop(shop_id));

DROP POLICY IF EXISTS "audit_logs_insert_member" ON public.audit_logs;
CREATE POLICY "audit_logs_insert_member" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (public.is_shop_member(shop_id) AND user_id = auth.uid());

-- tenant operational tables --------------------------------------------------
DROP POLICY IF EXISTS "categories_shop_isolation" ON public.categories;
CREATE POLICY "categories_shop_isolation" ON public.categories
  FOR ALL TO authenticated
  USING (public.is_shop_member(shop_id))
  WITH CHECK (public.is_shop_member(shop_id));

DROP POLICY IF EXISTS "inventory_items_shop_isolation" ON public.inventory_items;
CREATE POLICY "inventory_items_shop_isolation" ON public.inventory_items
  FOR ALL TO authenticated
  USING (public.is_shop_member(shop_id))
  WITH CHECK (public.is_shop_member(shop_id));

DROP POLICY IF EXISTS "recipes_shop_isolation" ON public.recipes;
CREATE POLICY "recipes_shop_isolation" ON public.recipes
  FOR ALL TO authenticated
  USING (public.is_shop_member(shop_id))
  WITH CHECK (public.is_shop_member(shop_id));

DROP POLICY IF EXISTS "recipe_ingredients_shop_isolation" ON public.recipe_ingredients;
CREATE POLICY "recipe_ingredients_shop_isolation" ON public.recipe_ingredients
  FOR ALL TO authenticated
  USING (public.is_shop_member(shop_id))
  WITH CHECK (public.is_shop_member(shop_id));

DROP POLICY IF EXISTS "receipts_shop_isolation" ON public.receipts;
CREATE POLICY "receipts_shop_isolation" ON public.receipts
  FOR ALL TO authenticated
  USING (public.is_shop_member(shop_id))
  WITH CHECK (public.is_shop_member(shop_id));

DROP POLICY IF EXISTS "receipt_items_shop_isolation" ON public.receipt_items;
CREATE POLICY "receipt_items_shop_isolation" ON public.receipt_items
  FOR ALL TO authenticated
  USING (public.is_shop_member(shop_id))
  WITH CHECK (public.is_shop_member(shop_id));

DROP POLICY IF EXISTS "orders_shop_isolation" ON public.orders;
CREATE POLICY "orders_shop_isolation" ON public.orders
  FOR ALL TO authenticated
  USING (public.is_shop_member(shop_id))
  WITH CHECK (public.is_shop_member(shop_id));

DROP POLICY IF EXISTS "order_items_shop_isolation" ON public.order_items;
CREATE POLICY "order_items_shop_isolation" ON public.order_items
  FOR ALL TO authenticated
  USING (public.is_shop_member(shop_id))
  WITH CHECK (public.is_shop_member(shop_id));

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.shops,
  public.profiles,
  public.shop_members,
  public.audit_logs,
  public.categories,
  public.inventory_items,
  public.recipes,
  public.recipe_ingredients,
  public.receipts,
  public.receipt_items,
  public.orders,
  public.order_items
TO authenticated;

-- Storage objects live in private buckets reachable through signed URLs only.
REVOKE ALL ON SCHEMA public FROM anon;
