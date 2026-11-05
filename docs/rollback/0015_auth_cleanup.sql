-- Copy into a NEW numbered forward migration if rolling back cleanup policy.
-- Never overwrite the applied 0015 migration or modify the ledger.
CREATE OR REPLACE FUNCTION app_private.cleanup_auth_records(batch_size integer DEFAULT 100) RETURNS void
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
REVOKE SELECT(action_token_id,sent_at,discarded_at,lease_until) ON auth_private.mail_outbox FROM neuton_maintenance;
REVOKE SELECT(consumed_at,invalidated_at) ON auth_private.action_tokens FROM neuton_maintenance;
REVOKE SELECT(consumed_at,transaction_id) ON auth_private.oauth_completions FROM neuton_maintenance;
REVOKE SELECT(status,browser_context_id,initiating_session_id,encrypted_verifier) ON auth_private.oauth_transactions FROM neuton_maintenance;
REVOKE UPDATE(encrypted_verifier,verifier_key_id) ON auth_private.oauth_transactions FROM neuton_maintenance;
REVOKE UPDATE(id) ON auth_private.mail_outbox,auth_private.oauth_completions,auth_private.browser_contexts,
 auth_private.action_tokens,auth_private.sessions,auth_private.security_events FROM neuton_maintenance;
