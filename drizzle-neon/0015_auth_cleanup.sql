-- Keep the existing cleanup-only entry point; do not edit the applied baseline.
GRANT SELECT(action_token_id,sent_at,discarded_at,lease_until) ON auth_private.mail_outbox TO neuton_maintenance;
GRANT SELECT(consumed_at,invalidated_at) ON auth_private.action_tokens TO neuton_maintenance;
GRANT SELECT(consumed_at,transaction_id) ON auth_private.oauth_completions TO neuton_maintenance;
GRANT SELECT(status,browser_context_id,initiating_session_id,encrypted_verifier) ON auth_private.oauth_transactions TO neuton_maintenance;
GRANT UPDATE(encrypted_verifier,verifier_key_id) ON auth_private.oauth_transactions TO neuton_maintenance;
-- PostgreSQL requires an UPDATE privilege for row locking, even when the routine only deletes.
GRANT UPDATE(id) ON auth_private.mail_outbox,auth_private.oauth_completions,auth_private.browser_contexts,
 auth_private.action_tokens,auth_private.sessions,auth_private.security_events TO neuton_maintenance;

CREATE OR REPLACE FUNCTION app_private.cleanup_auth_records(batch_size integer DEFAULT 100) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE limit_rows integer:=greatest(1,least(coalesce(batch_size,100),1000));
BEGIN
 -- A transaction-scoped lease serializes dispatchers and is released even after process/SQL failure.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('neuton:auth-cleanup',0)) THEN RETURN; END IF;
 PERFORM set_config('lock_timeout','1s',true);
 -- Remove mail first, without touching an in-flight SMTP lease. Parent deletes never cascade a backlog.
 DELETE FROM auth_private.mail_outbox WHERE id IN (
  SELECT m.id FROM auth_private.mail_outbox m
  WHERE (m.lease_until IS NULL OR m.lease_until<=statement_timestamp())
  AND (m.expires_at<=statement_timestamp() OR m.sent_at IS NOT NULL OR m.discarded_at IS NOT NULL
   OR EXISTS(SELECT 1 FROM auth_private.action_tokens t WHERE t.id=m.action_token_id
    AND (t.consumed_at IS NOT NULL OR t.invalidated_at IS NOT NULL OR t.expires_at<=statement_timestamp())))
  ORDER BY m.expires_at,m.id LIMIT limit_rows FOR UPDATE OF m SKIP LOCKED);
 DELETE FROM auth_private.oauth_completions WHERE id IN (
  SELECT id FROM auth_private.oauth_completions WHERE expires_at<=statement_timestamp() OR consumed_at IS NOT NULL
  ORDER BY expires_at,id LIMIT limit_rows FOR UPDATE SKIP LOCKED);
 -- An expired transaction may retain a verifier while children are drained. Erase it immediately.
 UPDATE auth_private.oauth_transactions SET encrypted_verifier=NULL,verifier_key_id=NULL WHERE id IN (
  SELECT id FROM auth_private.oauth_transactions
  WHERE encrypted_verifier IS NOT NULL AND (expires_at<=statement_timestamp() OR status IN ('completed','failed'))
  ORDER BY expires_at,id LIMIT limit_rows FOR UPDATE SKIP LOCKED);
 DELETE FROM auth_private.oauth_transactions WHERE id IN (
  SELECT t.id FROM auth_private.oauth_transactions t
  WHERE (t.expires_at<=statement_timestamp() OR t.status IN ('completed','failed'))
  AND NOT EXISTS(SELECT 1 FROM auth_private.oauth_completions c WHERE c.transaction_id=t.id)
  ORDER BY t.expires_at,t.id LIMIT limit_rows FOR UPDATE OF t SKIP LOCKED);
 DELETE FROM auth_private.browser_contexts WHERE id IN (
  SELECT b.id FROM auth_private.browser_contexts b WHERE b.expires_at<=statement_timestamp()
  AND NOT EXISTS(SELECT 1 FROM auth_private.oauth_transactions t WHERE t.browser_context_id=b.id)
  ORDER BY b.expires_at,b.id LIMIT limit_rows FOR UPDATE OF b SKIP LOCKED);
 DELETE FROM auth_private.action_tokens WHERE id IN (
  SELECT t.id FROM auth_private.action_tokens t
  WHERE (t.expires_at<=statement_timestamp() OR t.consumed_at IS NOT NULL OR t.invalidated_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM auth_private.mail_outbox m WHERE m.action_token_id=t.id)
  ORDER BY t.expires_at,t.id LIMIT limit_rows FOR UPDATE OF t SKIP LOCKED);
 DELETE FROM auth_private.sessions WHERE id IN (
  SELECT s.id FROM auth_private.sessions s
  WHERE least(s.revoked_at,s.idle_expires_at,s.absolute_expires_at)<=statement_timestamp()-interval '30 days'
  AND NOT EXISTS(SELECT 1 FROM auth_private.oauth_transactions t WHERE t.initiating_session_id=s.id)
  ORDER BY least(s.revoked_at,s.idle_expires_at,s.absolute_expires_at),s.id LIMIT limit_rows FOR UPDATE OF s SKIP LOCKED);
 DELETE FROM auth_private.security_events WHERE id IN (
  SELECT id FROM auth_private.security_events WHERE created_at<=statement_timestamp()-interval '90 days'
  ORDER BY created_at,id LIMIT limit_rows FOR UPDATE SKIP LOCKED);
END $$;
REVOKE ALL ON FUNCTION app_private.cleanup_auth_records(integer) FROM PUBLIC,neuton_app,neuton_auth,neuton_worker;
GRANT EXECUTE ON FUNCTION app_private.cleanup_auth_records(integer) TO neuton_cleanup;
