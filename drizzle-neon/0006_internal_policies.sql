GRANT SELECT,INSERT,UPDATE,DELETE ON auth_private.users,auth_private.password_credentials,
 auth_private.google_identities,auth_private.sessions,auth_private.action_tokens,auth_private.browser_contexts,
 auth_private.oauth_transactions,auth_private.oauth_completions,auth_private.mail_outbox TO neuton_auth;
GRANT SELECT,INSERT ON auth_private.security_events TO neuton_auth;
GRANT USAGE ON SCHEMA auth_private TO neuton_auth;

GRANT SELECT,INSERT,UPDATE ON public.media_uploads,public.document_mutations,public.inventory_adjustment_batches TO neuton_app;
GRANT SELECT ON public.document_versions TO neuton_app;
CREATE POLICY uploads_read ON public.media_uploads FOR SELECT TO neuton_app USING(app_private.shop_access(shop_id));
CREATE POLICY uploads_insert ON public.media_uploads FOR INSERT TO neuton_app
 WITH CHECK(app_private.shop_access(shop_id,true) AND uploaded_by=app_private.context_uuid('neuton.user_id'));
CREATE POLICY uploads_update ON public.media_uploads FOR UPDATE TO neuton_app
 USING(app_private.shop_access(shop_id,true)) WITH CHECK(app_private.shop_access(shop_id,true));
CREATE POLICY versions_read ON public.document_versions FOR SELECT TO neuton_app USING(app_private.shop_access(shop_id));
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['document_mutations','inventory_adjustment_batches'] LOOP
  EXECUTE format('CREATE POLICY own_read ON public.%I FOR SELECT TO neuton_app USING(app_private.shop_access(shop_id) AND user_id=app_private.context_uuid(''neuton.user_id''))',relation);
  EXECUTE format('CREATE POLICY own_insert ON public.%I FOR INSERT TO neuton_app WITH CHECK(app_private.shop_access(shop_id) AND user_id=app_private.context_uuid(''neuton.user_id''))',relation);
  EXECUTE format('CREATE POLICY own_update ON public.%I FOR UPDATE TO neuton_app USING(app_private.shop_access(shop_id) AND user_id=app_private.context_uuid(''neuton.user_id'')) WITH CHECK(app_private.shop_access(shop_id) AND user_id=app_private.context_uuid(''neuton.user_id''))',relation);
 END LOOP;
END $$;

GRANT SELECT ON app_private.job_authorizations TO neuton_policy_reader;
CREATE POLICY jobs_reader ON app_private.job_authorizations FOR SELECT TO neuton_policy_reader USING(true);
GRANT SELECT(id,shop_id,kind,receipt_id,recipe_id,order_id) ON public.media_uploads TO neuton_policy_reader;
GRANT SELECT(id,shop_id,status) ON public.receipts TO neuton_policy_reader;
GRANT SELECT(id,shop_id,status,is_active) ON public.recipes TO neuton_policy_reader;
GRANT SELECT(id,shop_id,status,deleted_at) ON public.orders TO neuton_policy_reader;
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['media_uploads','receipts','recipes','orders'] LOOP
  EXECUTE format('CREATE POLICY policy_reader ON public.%I FOR SELECT TO neuton_policy_reader USING(true)',relation);
 END LOOP;
END $$;

CREATE FUNCTION app_private.worker_access(target_shop uuid, write_kind text DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM app_private.job_authorizations j
 JOIN auth_private.users actor ON actor.id=j.requesting_user_id
 JOIN public.shop_members m ON m.shop_id=j.shop_id AND m.user_id=actor.id
 JOIN public.media_uploads u ON u.id=j.upload_id AND u.shop_id=j.shop_id
 WHERE j.job_id=current_setting('neuton.job_id',true) AND j.shop_id=target_shop
 AND j.shop_id=app_private.context_uuid('neuton.shop_id')
 AND j.requesting_user_id=app_private.context_uuid('neuton.user_id')
 AND actor.status='active' AND m.role IN ('owner','admin') AND j.expires_at>statement_timestamp()
 AND j.state IN ('accepted','queued','processing')
 AND (write_kind IS NULL OR write_kind='upload' OR
  (write_kind='receipt' AND j.operation='extract_receipt') OR
  (write_kind='recipe' AND j.operation='extract_recipe') OR
  (write_kind='order' AND j.operation='extract_order') OR
  (write_kind='inventory' AND j.operation='extract_product'))
 AND ((j.operation='extract_receipt' AND u.kind='receipt' AND u.receipt_id=j.resource_id
  AND EXISTS(SELECT 1 FROM public.receipts r WHERE r.id=j.resource_id AND r.shop_id=j.shop_id AND r.status IN ('pending','processing','unverified')))
 OR (j.operation='extract_recipe' AND u.kind='recipe' AND u.recipe_id=j.resource_id
  AND EXISTS(SELECT 1 FROM public.recipes r WHERE r.id=j.resource_id AND r.shop_id=j.shop_id AND r.is_active AND r.status IN ('pending','processing','unverified')))
 OR (j.operation='extract_order' AND u.kind='order' AND u.order_id=j.resource_id
  AND EXISTS(SELECT 1 FROM public.orders r WHERE r.id=j.resource_id AND r.shop_id=j.shop_id AND r.status='processing' AND r.deleted_at IS NULL))
 OR (j.operation='extract_product' AND u.kind='product' AND j.resource_id=u.id)))
$$;

CREATE FUNCTION app_private.claim_job_context(target_job text)
RETURNS TABLE(job_id text,shop_id uuid,requesting_user_id uuid,upload_id uuid,resource_kind text,resource_id uuid,operation text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job_record app_private.job_authorizations;
BEGIN
 IF target_job !~* '^upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN; END IF;
 SELECT * INTO job_record FROM app_private.job_authorizations j WHERE j.job_id=target_job;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('neuton:user:'||job_record.requesting_user_id::text,0));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('neuton:shop:'||job_record.shop_id::text,0));
 PERFORM set_config('neuton.job_id',target_job,true);
 PERFORM set_config('neuton.user_id',job_record.requesting_user_id::text,true);
 PERFORM set_config('neuton.session_id','',true);
 PERFORM set_config('neuton.shop_id',job_record.shop_id::text,true);
 IF NOT app_private.worker_access(job_record.shop_id) THEN RETURN; END IF;
 RETURN QUERY SELECT job_record.job_id::text,job_record.shop_id,job_record.requesting_user_id,
  job_record.upload_id,job_record.resource_kind,job_record.resource_id,job_record.operation;
END $$;
GRANT CREATE ON SCHEMA app_private TO neuton_policy_reader;
ALTER FUNCTION app_private.worker_access(uuid,text) OWNER TO neuton_policy_reader;
ALTER FUNCTION app_private.claim_job_context(text) OWNER TO neuton_policy_reader;
REVOKE CREATE ON SCHEMA app_private FROM neuton_policy_reader;
REVOKE ALL ON FUNCTION app_private.worker_access(uuid,text),app_private.claim_job_context(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.worker_access(uuid,text),app_private.claim_job_context(text) TO neuton_worker;

DO $$ DECLARE relation text; kind text; BEGIN
 FOREACH relation IN ARRAY ARRAY['shops','categories','inventory_items','recipes','recipe_ingredients','receipts','receipt_items','orders','order_items','media_uploads','document_versions'] LOOP
  GRANT USAGE ON SCHEMA public,app_private TO neuton_worker;
  EXECUTE format('GRANT SELECT ON public.%I TO neuton_worker',relation);
  IF relation='shops' THEN
   EXECUTE 'CREATE POLICY worker_read ON public.shops FOR SELECT TO neuton_worker USING(app_private.worker_access(id))';
  ELSE
   EXECUTE format('CREATE POLICY worker_read ON public.%I FOR SELECT TO neuton_worker USING(app_private.worker_access(shop_id))',relation);
  END IF;
 END LOOP;
 FOREACH relation IN ARRAY ARRAY['inventory_items','recipes','recipe_ingredients','receipts','receipt_items','orders','order_items','media_uploads'] LOOP
  kind:=CASE WHEN relation='inventory_items' THEN 'inventory' WHEN relation IN ('recipes','recipe_ingredients') THEN 'recipe'
   WHEN relation IN ('receipts','receipt_items') THEN 'receipt' WHEN relation IN ('orders','order_items') THEN 'order' ELSE 'upload' END;
  EXECUTE format('GRANT UPDATE ON public.%I TO neuton_worker',relation);
  IF relation IN ('inventory_items','recipe_ingredients','receipt_items','order_items') THEN EXECUTE format('GRANT INSERT ON public.%I TO neuton_worker',relation); END IF;
  IF relation IN ('recipe_ingredients','receipt_items','order_items') THEN EXECUTE format('GRANT DELETE ON public.%I TO neuton_worker',relation); END IF;
  EXECUTE format('CREATE POLICY worker_insert ON public.%I FOR INSERT TO neuton_worker WITH CHECK(app_private.worker_access(shop_id,%L))',relation,kind);
  EXECUTE format('CREATE POLICY worker_update ON public.%I FOR UPDATE TO neuton_worker USING(app_private.worker_access(shop_id,%L)) WITH CHECK(app_private.worker_access(shop_id,%L))',relation,kind,kind);
  EXECUTE format('CREATE POLICY worker_delete ON public.%I FOR DELETE TO neuton_worker USING(app_private.worker_access(shop_id,%L))',relation,kind);
 END LOOP;
END $$;
-- Reads may include costing inputs; writes are bound to this job's exact resource.
DO $$ DECLARE relation text; column_name text; job_column text; command text; BEGIN
 FOREACH relation IN ARRAY ARRAY['recipes','receipts','orders','media_uploads','recipe_ingredients','receipt_items','order_items'] LOOP
  column_name:=CASE WHEN relation='recipe_ingredients' THEN 'recipe_id' WHEN relation='receipt_items' THEN 'receipt_id' WHEN relation='order_items' THEN 'order_id' ELSE 'id' END;
  job_column:=CASE WHEN relation='media_uploads' THEN 'upload_id' ELSE 'resource_id' END;
  FOREACH command IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
   IF command='INSERT' THEN
    EXECUTE format('CREATE POLICY worker_exact_insert ON public.%I AS RESTRICTIVE FOR INSERT TO neuton_worker WITH CHECK(%I=(SELECT j.%I FROM app_private.job_authorizations j WHERE j.job_id=current_setting(''neuton.job_id'',true)))',relation,column_name,job_column);
   ELSIF command='DELETE' THEN
    EXECUTE format('CREATE POLICY worker_exact_delete ON public.%I AS RESTRICTIVE FOR DELETE TO neuton_worker USING(%I=(SELECT j.%I FROM app_private.job_authorizations j WHERE j.job_id=current_setting(''neuton.job_id'',true)))',relation,column_name,job_column);
   ELSE
    EXECUTE format('CREATE POLICY worker_exact_update ON public.%I AS RESTRICTIVE FOR UPDATE TO neuton_worker USING(%I=(SELECT j.%I FROM app_private.job_authorizations j WHERE j.job_id=current_setting(''neuton.job_id'',true))) WITH CHECK(%I=(SELECT j.%I FROM app_private.job_authorizations j WHERE j.job_id=current_setting(''neuton.job_id'',true)))',relation,column_name,job_column,column_name,job_column);
   END IF;
  END LOOP;
 END LOOP;
END $$;
GRANT SELECT ON app_private.job_authorizations TO neuton_worker;
CREATE POLICY worker_own_job ON app_private.job_authorizations FOR SELECT TO neuton_worker
 USING(job_id=current_setting('neuton.job_id',true) AND app_private.worker_access(shop_id));
-- No app/worker direct writes to auth tables, version rows, jobs or cleanup rows.
