-- Persisted jobs remain usable after logout, but never after loss of authority.
ALTER TABLE app_private.job_authorizations ADD COLUMN resource_revision bigint;
GRANT SELECT(sources,queued_at) ON public.media_uploads TO neuton_policy_reader;
CREATE OR REPLACE FUNCTION app_private.worker_access(target_shop uuid, write_kind text DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM app_private.job_authorizations j
 JOIN auth_private.users actor ON actor.id=j.requesting_user_id
 JOIN public.shop_members m ON m.shop_id=j.shop_id AND m.user_id=actor.id
 JOIN public.media_uploads u ON u.id=j.upload_id AND u.shop_id=j.shop_id
 WHERE j.job_id=current_setting('neuton.job_id',true) AND j.shop_id=target_shop
 AND j.shop_id=app_private.context_uuid('neuton.shop_id')
 AND j.requesting_user_id=app_private.context_uuid('neuton.user_id')
 AND actor.status='active' AND m.role IN ('owner','admin') AND j.expires_at>statement_timestamp()
 AND j.state IN ('accepted','queued','processing') AND u.queued_at IS NOT NULL
 AND j.sources_digest=encode(sha256(convert_to((SELECT jsonb_agg(value-'preview' ORDER BY ord)::text
 FROM jsonb_array_elements(u.sources) WITH ORDINALITY source(value,ord)),'UTF8')),'hex')
 AND (write_kind IS NULL OR write_kind='upload' OR
  (write_kind='receipt' AND j.operation='extract_receipt') OR
  (write_kind='recipe' AND j.operation IN ('extract_recipe','extract_product')) OR
  (write_kind='order' AND j.operation='extract_order'))
 AND ((j.operation='extract_receipt' AND u.kind='receipt' AND u.receipt_id=j.resource_id
  AND u.recipe_id IS NULL AND u.order_id IS NULL
  AND EXISTS(SELECT 1 FROM public.receipts r WHERE r.id=j.resource_id AND r.shop_id=j.shop_id AND r.status IN ('pending','processing','unverified','failed')))
 OR (j.operation='extract_recipe' AND u.kind='recipe' AND u.recipe_id=j.resource_id
  AND u.receipt_id IS NULL AND u.order_id IS NULL
  AND EXISTS(SELECT 1 FROM public.recipes r WHERE r.id=j.resource_id AND r.shop_id=j.shop_id AND r.is_active AND r.status IN ('pending','processing','unverified','failed')))
 OR (j.operation='extract_order' AND u.kind='order' AND u.order_id=j.resource_id
  AND u.receipt_id IS NULL AND u.recipe_id IS NULL
  AND EXISTS(SELECT 1 FROM public.orders r WHERE r.id=j.resource_id AND r.shop_id=j.shop_id AND r.status='processing' AND r.deleted_at IS NULL))
 OR (j.operation='extract_product' AND u.kind='product' AND j.resource_id=u.id
  AND u.receipt_id IS NULL AND u.order_id IS NULL
  AND EXISTS(SELECT 1 FROM public.recipes r WHERE r.id=u.recipe_id AND r.shop_id=j.shop_id AND r.is_active AND r.status IN ('pending','processing','unverified','failed')))))
$$;

-- Product documents use the existing recipe placeholder pipeline. They may
-- change that placeholder, never arbitrary inventory rows in its shop.
REVOKE INSERT,UPDATE,DELETE ON public.inventory_items FROM neuton_worker;
CREATE FUNCTION app_private.worker_resource_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN j.operation='extract_product' THEN u.recipe_id ELSE j.resource_id END
 FROM app_private.job_authorizations j JOIN public.media_uploads u ON u.id=j.upload_id AND u.shop_id=j.shop_id
 WHERE j.job_id=current_setting('neuton.job_id',true) AND app_private.worker_access(j.shop_id)
$$;
GRANT CREATE ON SCHEMA app_private TO neuton_policy_reader;
ALTER FUNCTION app_private.worker_resource_id() OWNER TO neuton_policy_reader;
REVOKE CREATE ON SCHEMA app_private FROM neuton_policy_reader;
REVOKE ALL ON FUNCTION app_private.worker_resource_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.worker_resource_id() TO neuton_worker;
DO $$ DECLARE relation text; field text; BEGIN
 FOREACH relation IN ARRAY ARRAY['recipes','recipe_ingredients'] LOOP
  field:=CASE WHEN relation='recipes' THEN 'id' ELSE 'recipe_id' END;
  EXECUTE format('DROP POLICY worker_exact_insert ON public.%I',relation);
  EXECUTE format('DROP POLICY worker_exact_update ON public.%I',relation);
  EXECUTE format('DROP POLICY worker_exact_delete ON public.%I',relation);
  EXECUTE format('CREATE POLICY worker_exact_insert ON public.%I AS RESTRICTIVE FOR INSERT TO neuton_worker WITH CHECK(%I=app_private.worker_resource_id())',relation,field);
  EXECUTE format('CREATE POLICY worker_exact_update ON public.%I AS RESTRICTIVE FOR UPDATE TO neuton_worker USING(%I=app_private.worker_resource_id()) WITH CHECK(%I=app_private.worker_resource_id())',relation,field,field);
  EXECUTE format('CREATE POLICY worker_exact_delete ON public.%I AS RESTRICTIVE FOR DELETE TO neuton_worker USING(%I=app_private.worker_resource_id())',relation,field);
 END LOOP;
END $$;

-- Called only after document -> upload row locks, serializing the last
-- authorization check and state transition with explicit job cancellation.
CREATE FUNCTION app_private.begin_job_stage(target_job text, start_processing boolean DEFAULT true) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job app_private.job_authorizations;
BEGIN
 IF target_job IS DISTINCT FROM current_setting('neuton.job_id',true) THEN RETURN false; END IF;
 SELECT * INTO job FROM app_private.job_authorizations WHERE job_id=target_job FOR UPDATE;
 IF NOT FOUND OR NOT app_private.worker_access(job.shop_id) THEN RETURN false; END IF;
 IF start_processing THEN
  UPDATE app_private.job_authorizations SET state='processing',started_at=coalesce(started_at,statement_timestamp()) WHERE job_id=target_job;
 END IF;
 RETURN true;
END $$;

CREATE FUNCTION app_private.pending_job_publications(batch_size integer DEFAULT 20) RETURNS TABLE(job_id text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT j.job_id::text FROM app_private.job_authorizations j
 WHERE j.state='accepted' ORDER BY j.created_at LIMIT greatest(1,least(batch_size,100))
$$;
CREATE FUNCTION app_private.mark_job_published(target_job text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job app_private.job_authorizations;
BEGIN
 SELECT * INTO job FROM app_private.job_authorizations WHERE job_id=target_job;
 IF NOT FOUND THEN RETURN; END IF;
 IF NOT (app_private.shop_access(job.shop_id,true) OR
  (target_job=current_setting('neuton.job_id',true) AND app_private.worker_access(job.shop_id))) THEN
  RAISE EXCEPTION 'Job publication forbidden' USING ERRCODE='42501';
 END IF;
 UPDATE app_private.job_authorizations SET state='queued',queued_at=coalesce(queued_at,statement_timestamp())
 WHERE job_id=target_job AND state='accepted';
END $$;
GRANT CREATE ON SCHEMA app_private TO neuton_maintenance;
ALTER FUNCTION app_private.begin_job_stage(text,boolean) OWNER TO neuton_maintenance;
ALTER FUNCTION app_private.pending_job_publications(integer) OWNER TO neuton_maintenance;
ALTER FUNCTION app_private.mark_job_published(text) OWNER TO neuton_maintenance;
REVOKE CREATE ON SCHEMA app_private FROM neuton_maintenance;
REVOKE ALL ON FUNCTION app_private.begin_job_stage(text,boolean),app_private.pending_job_publications(integer),app_private.mark_job_published(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.begin_job_stage(text,boolean),app_private.pending_job_publications(integer),app_private.mark_job_published(text) TO neuton_worker;
GRANT EXECUTE ON FUNCTION app_private.mark_job_published(text) TO neuton_app;

GRANT INSERT ON public.audit_logs TO neuton_worker;
GRANT EXECUTE ON FUNCTION app_private.context_uuid(text) TO neuton_worker;
CREATE POLICY worker_audit_insert ON public.audit_logs FOR INSERT TO neuton_worker
WITH CHECK(app_private.worker_access(shop_id) AND user_id=app_private.context_uuid('neuton.user_id')
 AND resource_id=app_private.worker_resource_id()
 AND event_type IN ('RECEIPT_PROCESSED','RECIPE_UPDATED','ORDER_UPDATED','DOCUMENT_PROCESSING_FAILED'));

-- Operation policies also limit which inputs may be read; column grants keep
-- processing from changing attribution, delivery/verification or lifecycle data.
REVOKE SELECT ON public.categories,public.document_versions FROM neuton_worker;
ALTER POLICY worker_read ON public.receipts USING(app_private.worker_access(shop_id,'receipt') AND id=app_private.worker_resource_id());
ALTER POLICY worker_read ON public.receipt_items USING(app_private.worker_access(shop_id,'receipt') AND receipt_id=app_private.worker_resource_id());
ALTER POLICY worker_read ON public.orders USING(app_private.worker_access(shop_id,'order') AND id=app_private.worker_resource_id());
ALTER POLICY worker_read ON public.order_items USING(app_private.worker_access(shop_id,'order') AND order_id=app_private.worker_resource_id());
ALTER POLICY worker_read ON public.media_uploads USING(app_private.worker_access(shop_id)
 AND id=(SELECT j.upload_id FROM app_private.job_authorizations j WHERE j.job_id=current_setting('neuton.job_id',true)));
ALTER POLICY worker_read ON public.recipes USING(app_private.worker_access(shop_id,'recipe') OR app_private.worker_access(shop_id,'order'));
ALTER POLICY worker_read ON public.recipe_ingredients USING(app_private.worker_access(shop_id,'order') OR
 (app_private.worker_access(shop_id,'recipe') AND recipe_id=app_private.worker_resource_id()));
ALTER POLICY worker_read ON public.inventory_items USING(app_private.worker_access(shop_id,'recipe') OR app_private.worker_access(shop_id,'order'));
ALTER POLICY worker_read ON public.shops USING(app_private.worker_access(id,'recipe') OR app_private.worker_access(id,'order'));
REVOKE UPDATE ON public.receipts,public.recipes,public.orders,public.media_uploads,public.recipe_ingredients,public.receipt_items,public.order_items FROM neuton_worker;
GRANT UPDATE(status,progress_stage,progress_message,processing_started_at,processing_deadline,updated_at,
 merchant_name,receipt_date,total_amount,tax_amount,currency,processed_at,error_message) ON public.receipts TO neuton_worker;
GRANT UPDATE(status,error_message,updated_at,name,description,prep_time_minutes,yield_quantity,yield_unit,allergens,steps) ON public.recipes TO neuton_worker;
GRANT UPDATE(customer_name,destination_address,total_cost,total_amount) ON public.orders TO neuton_worker;
GRANT UPDATE(processed_at,sources) ON public.media_uploads TO neuton_worker;
GRANT UPDATE(general_price_id) ON public.recipe_ingredients TO neuton_worker;

-- Detect human edits between processing stages without giving a runtime role
-- direct access to mutation/version metadata. The version lock is short lived.
GRANT SELECT ON public.document_versions TO neuton_maintenance;
GRANT UPDATE(updated_at) ON public.document_versions TO neuton_maintenance;
CREATE POLICY maintenance_job_revision ON public.document_versions TO neuton_maintenance USING(true) WITH CHECK(true);
GRANT EXECUTE ON FUNCTION app_private.worker_resource_id() TO neuton_maintenance;
CREATE FUNCTION app_private.job_revision(target_job text, capture boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job app_private.job_authorizations; revision bigint; document_kind text;
BEGIN
 IF target_job IS DISTINCT FROM current_setting('neuton.job_id',true) THEN RETURN false; END IF;
 SELECT * INTO job FROM app_private.job_authorizations WHERE job_id=target_job;
 IF NOT FOUND OR NOT app_private.worker_access(job.shop_id) THEN RETURN false; END IF;
 document_kind:=CASE WHEN job.operation='extract_product' THEN 'recipe' ELSE job.resource_kind END;
 SELECT updated_at INTO revision FROM public.document_versions
 WHERE shop_id=job.shop_id AND kind=document_kind AND id=app_private.worker_resource_id() FOR UPDATE;
 IF revision IS NULL THEN RETURN false; END IF;
 IF capture OR job.resource_revision IS NULL THEN
  UPDATE app_private.job_authorizations SET resource_revision=revision WHERE job_id=target_job;
  RETURN true;
 END IF;
 RETURN revision=job.resource_revision;
END $$;
GRANT CREATE ON SCHEMA app_private TO neuton_maintenance;
ALTER FUNCTION app_private.job_revision(text,boolean) OWNER TO neuton_maintenance;
REVOKE CREATE ON SCHEMA app_private FROM neuton_maintenance;
REVOKE ALL ON FUNCTION app_private.job_revision(text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.job_revision(text,boolean) TO neuton_worker;

CREATE OR REPLACE FUNCTION app_private.register_job(target_upload uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE upload public.media_uploads; existing app_private.job_authorizations;
 job text; resource uuid; kind text; previous_job text;
BEGIN
 SELECT * INTO upload FROM public.media_uploads WHERE id=target_upload;
 IF NOT FOUND OR NOT app_private.shop_access(upload.shop_id,true) THEN RAISE EXCEPTION 'Job submission forbidden' USING ERRCODE='42501'; END IF;
 IF upload.queued_at IS NULL THEN RETURN NULL; END IF;
 job:='upload-'||upload.id::text;
 SELECT * INTO existing FROM app_private.job_authorizations WHERE job_id=job;
 IF FOUND THEN
  IF existing.state IN ('failed','cancelled') OR (existing.state<>'completed' AND existing.expires_at<=statement_timestamp()) THEN RETURN NULL; END IF;
  RETURN job;
 END IF;
 IF upload.processed_at IS NOT NULL THEN RETURN NULL; END IF;
 kind:=CASE WHEN upload.kind='product' THEN 'upload' ELSE upload.kind END;
 resource:=CASE upload.kind WHEN 'receipt' THEN upload.receipt_id WHEN 'recipe' THEN upload.recipe_id WHEN 'order' THEN upload.order_id ELSE upload.id END;
 INSERT INTO app_private.job_authorizations(job_id,shop_id,requesting_user_id,upload_id,resource_kind,resource_id,operation,sources_digest,correlation_id,expires_at)
 VALUES(job,upload.shop_id,app_private.context_uuid('neuton.user_id'),upload.id,kind,resource,'extract_'||upload.kind,
 encode(sha256(convert_to((SELECT jsonb_agg(value-'preview' ORDER BY ord)::text FROM jsonb_array_elements(upload.sources) WITH ORDINALITY source(value,ord)),'UTF8')),'hex'),
 coalesce(nullif(current_setting('neuton.trace_id',true),''),'job-submission'),statement_timestamp()+interval '1 day')
 ON CONFLICT(job_id) DO NOTHING;
 previous_job:=coalesce(current_setting('neuton.job_id',true),'');
 PERFORM set_config('neuton.job_id',job,true);
 IF NOT app_private.worker_access(upload.shop_id) THEN RAISE EXCEPTION 'Job resource unavailable' USING ERRCODE='55000'; END IF;
 IF NOT app_private.job_revision(job,false) THEN RAISE EXCEPTION 'Job revision unavailable' USING ERRCODE='55000'; END IF;
 PERFORM set_config('neuton.job_id',previous_job,true);
 RETURN job;
END $$;

CREATE OR REPLACE FUNCTION app_private.finish_job(target_job text, outcome text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target_shop uuid; changed integer;
BEGIN
 IF outcome NOT IN ('completed','failed','cancelled') OR target_job IS DISTINCT FROM current_setting('neuton.job_id',true) THEN RETURN false; END IF;
 SELECT shop_id INTO target_shop FROM app_private.job_authorizations WHERE job_id=target_job;
 IF target_shop IS NULL THEN RETURN false; END IF;
 -- Cancellation changes only this job record, including after its authority
 -- expires. No stale document/status mutation is permitted through this path.
 IF outcome<>'cancelled' AND NOT app_private.worker_access(target_shop) THEN RETURN false; END IF;
 UPDATE app_private.job_authorizations SET state=outcome,finished_at=statement_timestamp(),
  cancelled_at=CASE WHEN outcome='cancelled' THEN statement_timestamp() ELSE NULL END,
  cancellation_reason=CASE WHEN outcome='cancelled' THEN 'authorization_or_resource_invalid' ELSE NULL END
 WHERE job_id=target_job AND state IN ('accepted','queued','processing');
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN changed=1;
END $$;
