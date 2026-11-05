# Auth retention operations

The API runs `AuthCleanupDispatcher` every minute using `CLEANUP_DATABASE_URL`, shared with the storage cleanup pool. It invokes only `app_private.cleanup_auth_records(100)`. The function owns a transaction-scoped advisory lease, skips locked rows and limits each relation/stage to 100 rows (hard maximum 1000). Process exit releases the lease; shutdown drains an in-flight pass before closing the pool. A bounded `auth_cleanup_failed` event signals retry on the next tick. Monitor failures and retention backlog; cleanup delay never changes access-time expiry, status, version or revocation checks.

Expired, consumed or invalidated actions, expired browser contexts, spent completion tickets and terminal/expired OAuth transactions are removed. Completed transactions remain while a live completion ticket needs them. Expired verifiers are erased even while dependent records drain. Mail is removed after delivery/discard, expiry or action invalidation, once any SMTP lease ends. Parent deletes wait for children to drain, avoiding unbounded cascading removal of mail or OAuth backlogs. Live actions, mail leases, OAuth tickets and active sessions remain usable.

Session metadata is removed 30 days after the earliest revocation, idle expiry or absolute expiry; security events are removed after 90 days. These are the policy horizons; the bounded minute scheduler can take multiple passes to drain a backlog. Cleanup may delete expired records sooner only for the temporary tables. It never deletes accounts, profiles, Google mappings, credentials, memberships or business history. The cleanup login cannot read private tables or directly delete append-only events. Only the no-login maintenance function owner has the required column privileges; app/auth/worker roles cannot call the routine.

## Encryption key rotation

Keep the active key and every old key still referenced by a recoverable pending mail payload or OAuth verifier in `AUTH_ENCRYPTION_KEYS`. Deploy a new active key while retaining referenced old keys. Let valid records complete/expire and cleanup drain them before retiring an old key. Retrying mail reuses its existing encrypted payload; never mint a new action merely to rotate keys. Cleanup needs no encryption keys and can erase expired ciphertext even if its key is unavailable. An authorized operator can inspect aggregate key references without decrypting or printing payloads:

```sql
SELECT payload_key_id AS key_id, count(*) FROM auth_private.mail_outbox
WHERE encrypted_payload IS NOT NULL GROUP BY payload_key_id;
SELECT verifier_key_id AS key_id, count(*) FROM auth_private.oauth_transactions
WHERE encrypted_verifier IS NOT NULL GROUP BY verifier_key_id;
```

Retire a key only when both counts are zero after all API instances have switched active keys. Failure to decrypt a still-valid record remains a delivery/authentication failure; cleanup is not a fallback authority.

## Rollback

Revert the dispatcher runtime commit to stop scheduling. To restore the earlier SQL behavior, apply the supplied `docs/rollback/0015_auth_cleanup.sql` as a new, numbered forward migration with the guarded operator migration runner. Do not edit applied migrations or their ledger. Already removed temporary records are intentionally unrecoverable; users restart expired or consumed actions. Existing account and business records are unaffected.
