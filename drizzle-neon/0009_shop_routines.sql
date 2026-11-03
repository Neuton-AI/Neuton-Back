GRANT USAGE ON SCHEMA auth_private TO neuton_bootstrap;
GRANT SELECT(id,status) ON auth_private.users TO neuton_bootstrap;
GRANT SELECT,INSERT ON public.profiles,public.shops,public.shop_members TO neuton_bootstrap;
GRANT UPDATE(last_order_number) ON public.shops TO neuton_bootstrap;
GRANT UPDATE(role),DELETE ON public.shop_members TO neuton_bootstrap;
GRANT SELECT(id,shop_id,status),UPDATE(status) ON public.orders TO neuton_bootstrap;
GRANT INSERT ON public.audit_logs TO neuton_bootstrap;
CREATE POLICY bootstrap_profiles ON public.profiles TO neuton_bootstrap USING(true) WITH CHECK(true);
CREATE POLICY bootstrap_shops ON public.shops TO neuton_bootstrap USING(true) WITH CHECK(true);
CREATE POLICY bootstrap_members ON public.shop_members TO neuton_bootstrap USING(true) WITH CHECK(true);
CREATE POLICY bootstrap_orders ON public.orders TO neuton_bootstrap USING(true) WITH CHECK(true);
CREATE POLICY bootstrap_audit ON public.audit_logs FOR INSERT TO neuton_bootstrap WITH CHECK(true);

CREATE FUNCTION app_private.create_profile(target uuid,full_name text DEFAULT NULL,avatar_url text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF length(full_name)>120 OR length(avatar_url)>500 OR NOT EXISTS(SELECT 1 FROM auth_private.users WHERE id=target AND status='pending_email') THEN
  RAISE EXCEPTION 'Profile creation forbidden' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.profiles(id,full_name,avatar_url) VALUES(target,full_name,avatar_url) ON CONFLICT(id) DO NOTHING;
END $$;
CREATE FUNCTION app_private.auth_profile(target uuid) RETURNS TABLE(id uuid,full_name text,avatar_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p.id,p.full_name,p.avatar_url FROM public.profiles p WHERE p.id=target
$$;

CREATE FUNCTION app_private.create_shop(p_name text,p_slug text,p_address text DEFAULT NULL,p_margin numeric DEFAULT 35,
 p_labor numeric DEFAULT 18,p_delivery_base numeric DEFAULT 3,p_delivery_rate numeric DEFAULT 0.8) RETURNS public.shops
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=app_private.context_uuid('neuton.user_id'); result public.shops; candidate text:=p_slug; attempt integer;
BEGIN
 IF NOT app_private.lock_user_context() THEN RAISE EXCEPTION 'Invalid active session' USING ERRCODE='42501'; END IF;
 IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 2 AND 120 OR p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9-]{1,79}$'
 OR p_slug IN ('admin','app','api','login','settings','dashboard','profile','catalog','orders','capture','auth')
 OR length(p_address)>300 OR p_margin IS NULL OR p_margin NOT BETWEEN 0 AND 999
 OR p_labor IS NULL OR p_labor NOT BETWEEN 0 AND 100000 OR p_delivery_base IS NULL OR p_delivery_base NOT BETWEEN 0 AND 100000
 OR p_delivery_rate IS NULL OR p_delivery_rate NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'Invalid shop input' USING ERRCODE='23514'; END IF;
 FOR attempt IN 1..5 LOOP
  BEGIN
   INSERT INTO public.shops(name,slug,store_address,target_profit_margin,hourly_labor_cost,delivery_base_fee,delivery_rate_per_km)
   VALUES(p_name,candidate,p_address,p_margin,p_labor,p_delivery_base,p_delivery_rate) RETURNING * INTO result;
   EXIT;
  EXCEPTION WHEN unique_violation THEN
   IF attempt=5 THEN RAISE; END IF;
   candidate:=left(p_slug,70)||'-'||left(gen_random_uuid()::text,8);
  END;
 END LOOP;
 INSERT INTO public.shop_members(shop_id,user_id,role) VALUES(result.id,actor,'owner');
 INSERT INTO public.audit_logs(shop_id,user_id,event_type,resource_id) VALUES(result.id,actor,'SHOP_CREATED',result.id);
 RETURN result;
END $$;

CREATE FUNCTION app_private.change_membership(target_shop uuid,target_user uuid,new_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor_role text; old_role text;
BEGIN
 IF NOT app_private.lock_user_context() THEN RAISE EXCEPTION 'Invalid active session' USING ERRCODE='42501'; END IF;
 IF new_role IS NOT NULL AND new_role NOT IN ('owner','admin','member') THEN RAISE EXCEPTION 'Invalid membership role' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('neuton:user:'||target_user::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('neuton:shop:'||target_shop::text,0));
 PERFORM 1 FROM public.shops WHERE id=target_shop FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Shop unavailable' USING ERRCODE='42501'; END IF;
 actor_role:=app_private.member_role(target_shop);
 IF actor_role IS NULL OR actor_role NOT IN ('owner','admin') THEN RAISE EXCEPTION 'Membership change forbidden' USING ERRCODE='42501'; END IF;
 SELECT role INTO old_role FROM public.shop_members WHERE shop_id=target_shop AND user_id=target_user FOR UPDATE;
 IF actor_role='admin' AND (coalesce(old_role,'')='owner' OR coalesce(new_role,'')='owner') THEN
  RAISE EXCEPTION 'Owner capability required' USING ERRCODE='42501';
 END IF;
 IF (coalesce(old_role,'')='owner' OR coalesce(new_role,'')='owner') AND NOT app_private.recent_authentication() THEN
  RAISE EXCEPTION 'Recent authentication required' USING ERRCODE='42501';
 END IF;
 IF old_role='owner' AND new_role IS DISTINCT FROM 'owner' AND (SELECT count(*) FROM public.shop_members WHERE shop_id=target_shop AND role='owner')<=1 THEN
  RAISE EXCEPTION 'The last owner must remain' USING ERRCODE='23514';
 END IF;
 IF new_role IS NULL THEN DELETE FROM public.shop_members WHERE shop_id=target_shop AND user_id=target_user;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM auth_private.users WHERE id=target_user AND status='active') THEN RAISE EXCEPTION 'Target account unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO public.shop_members(shop_id,user_id,role) VALUES(target_shop,target_user,new_role)
  ON CONFLICT(shop_id,user_id) DO UPDATE SET role=excluded.role;
 END IF;
 INSERT INTO public.audit_logs(shop_id,user_id,event_type,resource_id,metadata)
 VALUES(target_shop,app_private.context_uuid('neuton.user_id'),'MEMBERSHIP_CHANGED',target_user,jsonb_build_object('previousRole',old_role,'role',new_role));
END $$;

CREATE FUNCTION app_private.next_order_number() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result integer;
BEGIN
 IF app_private.lock_shop_context() IS NULL OR NOT app_private.shop_access(app_private.context_uuid('neuton.shop_id'),true) THEN
  RAISE EXCEPTION 'Order creation forbidden' USING ERRCODE='42501';
 END IF;
 UPDATE public.shops SET last_order_number=last_order_number+1 WHERE id=app_private.context_uuid('neuton.shop_id') RETURNING last_order_number INTO result;
 RETURN result;
END $$;
CREATE FUNCTION app_private.mark_order_delivered(target uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed integer;
BEGIN
 IF app_private.lock_shop_context() IS NULL THEN RAISE EXCEPTION 'Order verification forbidden' USING ERRCODE='42501'; END IF;
 UPDATE public.orders SET status='delivered' WHERE id=target AND shop_id=app_private.context_uuid('neuton.shop_id') AND status='processing';
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN changed=1;
END $$;
GRANT CREATE ON SCHEMA app_private TO neuton_bootstrap;
DO $$ DECLARE fn record; BEGIN
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='app_private' AND p.proname IN ('create_profile','auth_profile','create_shop','change_membership','next_order_number','mark_order_delivered') LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO neuton_bootstrap',fn.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA app_private FROM neuton_bootstrap;
GRANT EXECUTE ON FUNCTION app_private.create_profile(uuid,text,text),app_private.auth_profile(uuid) TO neuton_auth;
GRANT EXECUTE ON FUNCTION app_private.create_shop(text,text,text,numeric,numeric,numeric,numeric),
 app_private.change_membership(uuid,uuid,text),app_private.next_order_number(),app_private.mark_order_delivered(uuid) TO neuton_app;
