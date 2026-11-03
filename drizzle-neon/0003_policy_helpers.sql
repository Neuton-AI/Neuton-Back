-- Reader helpers never receive credential hashes, bearer digests or auth DML.
GRANT USAGE ON SCHEMA public, auth_private, app_private TO neuton_policy_reader;
GRANT USAGE ON SCHEMA public, app_private TO neuton_app, neuton_worker, neuton_bootstrap;
GRANT USAGE ON SCHEMA auth_private, app_private TO neuton_auth, neuton_cleanup;
GRANT SELECT(id,status,security_version) ON auth_private.users TO neuton_policy_reader;
GRANT SELECT(id,user_id,security_version,revoked_at,idle_expires_at,absolute_expires_at,recent_authenticated_at,authentication_method)
  ON auth_private.sessions TO neuton_policy_reader;
GRANT SELECT ON public.shop_members TO neuton_policy_reader;
CREATE POLICY memberships_policy_reader ON public.shop_members FOR SELECT TO neuton_policy_reader USING (true);

CREATE FUNCTION app_private.context_uuid(setting_name text) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE value text;
BEGIN
 IF setting_name NOT IN ('neuton.user_id','neuton.session_id','neuton.shop_id') THEN RETURN NULL; END IF;
 value:=current_setting(setting_name,true);
 IF value IS NULL OR value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
 RETURN value::uuid;
END $$;

CREATE FUNCTION app_private.session_valid() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM auth_private.users u JOIN auth_private.sessions s ON s.user_id=u.id
 WHERE u.id=app_private.context_uuid('neuton.user_id') AND s.id=app_private.context_uuid('neuton.session_id')
 AND u.status='active' AND s.security_version=u.security_version AND s.revoked_at IS NULL
 AND s.idle_expires_at>statement_timestamp() AND s.absolute_expires_at>statement_timestamp())
$$;

CREATE FUNCTION app_private.member_role(target_shop uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT m.role FROM public.shop_members m WHERE app_private.session_valid()
 AND m.user_id=app_private.context_uuid('neuton.user_id') AND m.shop_id=target_shop
$$;

CREATE FUNCTION app_private.shop_access(target_shop uuid, administrative boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(target_shop=app_private.context_uuid('neuton.shop_id') AND
 CASE WHEN administrative THEN app_private.member_role(target_shop) IN ('owner','admin')
 ELSE app_private.member_role(target_shop) IN ('owner','admin','member') END,false)
$$;

CREATE FUNCTION app_private.recent_authentication(method text DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app_private.session_valid() AND EXISTS(SELECT 1 FROM auth_private.sessions s
 WHERE s.id=app_private.context_uuid('neuton.session_id')
 AND s.recent_authenticated_at>statement_timestamp()-interval '10 minutes'
 AND s.recent_authenticated_at<=statement_timestamp()
 AND (method IS NULL OR s.authentication_method=method))
$$;

-- Shared advisory guards let a SELECT-only definer lock security state without
-- UPDATE grants. Revocation takes the matching exclusive user guard first.
CREATE FUNCTION app_private.lock_user_context() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=app_private.context_uuid('neuton.user_id');
BEGIN
 IF actor IS NULL OR app_private.context_uuid('neuton.session_id') IS NULL THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('neuton:user:'||actor::text,0));
 RETURN app_private.session_valid();
END $$;

CREATE FUNCTION app_private.lock_shop_context() RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target uuid:=app_private.context_uuid('neuton.shop_id');
BEGIN
 IF NOT app_private.lock_user_context() THEN RAISE EXCEPTION 'Invalid active session' USING ERRCODE='28000'; END IF;
 IF target IS NULL THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('neuton:shop:'||target::text,0));
 RETURN app_private.member_role(target);
END $$;

-- Temporary CREATE is needed to transfer function ownership; it is removed.
GRANT CREATE ON SCHEMA app_private TO neuton_policy_reader;
DO $$ DECLARE fn record; BEGIN
 FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='app_private' AND p.proname IN
 ('context_uuid','session_valid','member_role','shop_access','recent_authentication','lock_user_context','lock_shop_context') LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO neuton_policy_reader',fn.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO neuton_app,neuton_bootstrap',fn.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA app_private FROM neuton_policy_reader;
