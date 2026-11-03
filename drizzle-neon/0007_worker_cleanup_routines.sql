-- NOLOGIN internal owner is distinct from identity bootstrap; no new credential.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='neuton_maintenance') THEN
  CREATE ROLE neuton_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='neuton_maintenance'
 AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit
 OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid))) THEN
  RAISE EXCEPTION 'Unsafe maintenance function owner';
 END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public,auth_private,app_private FROM neuton_maintenance;
GRANT USAGE ON SCHEMA public,auth_private,app_private TO neuton_maintenance;
GRANT EXECUTE ON FUNCTION app_private.shop_access(uuid,boolean),app_private.context_uuid(text),
 app_private.worker_access(uuid,text) TO neuton_maintenance;
GRANT SELECT ON public.media_uploads TO neuton_maintenance;
CREATE POLICY maintenance_upload_read ON public.media_uploads FOR SELECT TO neuton_maintenance USING(true);
GRANT SELECT,INSERT,UPDATE ON app_private.job_authorizations TO neuton_maintenance;
CREATE POLICY maintenance_jobs ON app_private.job_authorizations TO neuton_maintenance USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.storage_object_deletions TO neuton_maintenance;
CREATE POLICY maintenance_storage ON public.storage_object_deletions TO neuton_maintenance USING(true) WITH CHECK(true);

CREATE FUNCTION app_private.register_job(target_upload uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE upload public.media_uploads; job text; resource uuid; kind text;
BEGIN
 SELECT * INTO upload FROM public.media_uploads WHERE id=target_upload;
 IF NOT FOUND OR NOT app_private.shop_access(upload.shop_id,true) THEN RAISE EXCEPTION 'Job submission forbidden' USING ERRCODE='42501'; END IF;
 job:='upload-'||upload.id::text;
 kind:=CASE WHEN upload.kind='product' THEN 'upload' ELSE upload.kind END;
 resource:=CASE upload.kind WHEN 'receipt' THEN upload.receipt_id WHEN 'recipe' THEN upload.recipe_id WHEN 'order' THEN upload.order_id ELSE upload.id END;
 INSERT INTO app_private.job_authorizations(job_id,shop_id,requesting_user_id,upload_id,resource_kind,resource_id,operation,sources_digest,correlation_id,expires_at)
 VALUES(job,upload.shop_id,app_private.context_uuid('neuton.user_id'),upload.id,kind,resource,'extract_'||upload.kind,
 encode(sha256(convert_to((SELECT jsonb_agg(value-'preview' ORDER BY ord)::text FROM jsonb_array_elements(upload.sources) WITH ORDINALITY source(value,ord)),'UTF8')),'hex'),
 coalesce(nullif(current_setting('neuton.trace_id',true),''),'job-submission'),statement_timestamp()+interval '1 day')
 ON CONFLICT(job_id) DO NOTHING;
 RETURN job;
END $$;

CREATE FUNCTION app_private.finish_job(target_job text, outcome text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target_shop uuid; changed integer;
BEGIN
 IF outcome NOT IN ('completed','failed','cancelled') OR target_job IS DISTINCT FROM current_setting('neuton.job_id',true) THEN RETURN false; END IF;
 SELECT shop_id INTO target_shop FROM app_private.job_authorizations WHERE job_id=target_job;
 IF target_shop IS NULL THEN RETURN false; END IF;
 IF outcome='cancelled' THEN
  IF app_private.worker_access(target_shop) THEN RETURN false; END IF;
 ELSIF NOT app_private.worker_access(target_shop) THEN RETURN false;
 END IF;
 UPDATE app_private.job_authorizations SET state=outcome,finished_at=statement_timestamp(),
  cancelled_at=CASE WHEN outcome='cancelled' THEN statement_timestamp() ELSE NULL END,
  cancellation_reason=CASE WHEN outcome='cancelled' THEN 'authorization_invalid' ELSE NULL END
 WHERE job_id=target_job AND state IN ('accepted','queued','processing');
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN changed=1;
END $$;

CREATE FUNCTION app_private.enqueue_storage_deletions(paths text[], trace text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target uuid:=app_private.context_uuid('neuton.shop_id'); path text;
BEGIN
 IF NOT coalesce(app_private.shop_access(target,true),false) OR cardinality(paths)>20 OR length(trace)>128 THEN
  RAISE EXCEPTION 'Storage cleanup submission forbidden' USING ERRCODE='42501';
 END IF;
 FOREACH path IN ARRAY paths LOOP
  IF path IS NULL THEN CONTINUE; END IF;
  IF left(path,37)<>target::text||'/' OR length(path)>2048 THEN RAISE EXCEPTION 'Invalid storage path' USING ERRCODE='23514'; END IF;
  INSERT INTO public.storage_object_deletions(shop_id,storage_path,trace_id)
  VALUES(target,path,coalesce(trace,'storage-cleanup')) ON CONFLICT(shop_id,storage_path) DO NOTHING;
 END LOOP;
END $$;

CREATE FUNCTION app_private.claim_storage_deletions(lease uuid, batch_size integer DEFAULT 10, lease_seconds integer DEFAULT 60)
RETURNS TABLE(id uuid,shop_id uuid,storage_path text,trace_id text,attempts integer)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH due AS (SELECT d.id FROM public.storage_object_deletions d
 WHERE lease IS NOT NULL AND d.next_attempt_at<=statement_timestamp() AND (d.lease_until IS NULL OR d.lease_until<=statement_timestamp())
 ORDER BY d.next_attempt_at,d.created_at FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(batch_size,20)))
 UPDATE public.storage_object_deletions d SET lease_token=lease,
 lease_until=statement_timestamp()+make_interval(secs=>greatest(30,least(lease_seconds,300))),attempts=d.attempts+1
 FROM due WHERE d.id=due.id RETURNING d.id,d.shop_id,d.storage_path,d.trace_id,d.attempts
$$;
CREATE FUNCTION app_private.complete_storage_deletion(target uuid, lease uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH removed AS (DELETE FROM public.storage_object_deletions WHERE id=target AND lease_token=lease RETURNING id)
 SELECT EXISTS(SELECT 1 FROM removed)
$$;
CREATE FUNCTION app_private.retry_storage_deletion(target uuid, lease uuid, delay_seconds integer DEFAULT 60) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 UPDATE public.storage_object_deletions SET lease_token=NULL,lease_until=NULL,
 next_attempt_at=statement_timestamp()+make_interval(secs=>greatest(30,least(delay_seconds,3600)))
 WHERE id=target AND lease_token=lease
$$;

GRANT DELETE ON auth_private.mail_outbox,auth_private.oauth_completions,auth_private.oauth_transactions,
 auth_private.browser_contexts,auth_private.action_tokens,auth_private.sessions,auth_private.security_events TO neuton_maintenance;
GRANT SELECT(id,expires_at) ON auth_private.mail_outbox,auth_private.oauth_completions,auth_private.oauth_transactions,
 auth_private.browser_contexts,auth_private.action_tokens TO neuton_maintenance;
GRANT SELECT(id,idle_expires_at,absolute_expires_at,revoked_at) ON auth_private.sessions TO neuton_maintenance;
GRANT SELECT(id,created_at) ON auth_private.security_events TO neuton_maintenance;
CREATE FUNCTION app_private.cleanup_auth_records(batch_size integer DEFAULT 100) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE limit_rows integer:=greatest(1,least(batch_size,1000)); relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['mail_outbox','oauth_completions','oauth_transactions','browser_contexts','action_tokens'] LOOP
  EXECUTE format('DELETE FROM auth_private.%I WHERE id IN (SELECT id FROM auth_private.%I WHERE expires_at<statement_timestamp() ORDER BY expires_at LIMIT $1)',relation,relation) USING limit_rows;
 END LOOP;
 DELETE FROM auth_private.sessions WHERE id IN (SELECT id FROM auth_private.sessions
 WHERE coalesce(revoked_at,least(idle_expires_at,absolute_expires_at))<statement_timestamp()-interval '30 days'
 ORDER BY absolute_expires_at LIMIT limit_rows);
 DELETE FROM auth_private.security_events WHERE id IN (SELECT id FROM auth_private.security_events
 WHERE created_at<statement_timestamp()-interval '90 days' ORDER BY created_at LIMIT limit_rows);
END $$;

GRANT CREATE ON SCHEMA app_private TO neuton_maintenance;
DO $$ DECLARE fn record; BEGIN
 FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='app_private' AND p.proname IN ('register_job','finish_job','enqueue_storage_deletions',
 'claim_storage_deletions','complete_storage_deletion','retry_storage_deletion','cleanup_auth_records') LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO neuton_maintenance',fn.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA app_private FROM neuton_maintenance;
GRANT EXECUTE ON FUNCTION app_private.register_job(uuid),app_private.enqueue_storage_deletions(text[],text) TO neuton_app;
GRANT EXECUTE ON FUNCTION app_private.finish_job(text,text) TO neuton_worker;
GRANT EXECUTE ON FUNCTION app_private.claim_storage_deletions(uuid,integer,integer),app_private.complete_storage_deletion(uuid,uuid),
 app_private.retry_storage_deletion(uuid,uuid,integer),app_private.cleanup_auth_records(integer) TO neuton_cleanup;
