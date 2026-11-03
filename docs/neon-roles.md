# Restricted Neon roles

Run `npm run db:provision` explicitly using shell/deployment-injected MIGRATION_DATABASE_URL plus DATABASE_URL, AUTH_DATABASE_URL, WORKER_DATABASE_URL and CLEANUP_DATABASE_URL. The command does not load environment files. It extracts each runtime password from its corresponding URL; no password is embedded in SQL files or printed. It does not run during API startup, change existing passwords or repair unsafe existing roles silently.

The migration owner needs CREATEROLE and database/schema-owner permissions. The runtime URLs use neuton_app, neuton_auth, neuton_worker and neuton_cleanup, all LOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS. They have no membership in any other role and own no objects. NOLOGIN neuton_policy_reader and neuton_bootstrap own only narrow helpers introduced by the baseline. The provisioning transaction serializes its work, rejects privilege drift, removes PUBLIC database/schema privileges and default PUBLIC table/sequence/function grants, and grants only database CONNECT to runtime roles. The baseline supplies deliberate schema/table/routine grants afterward.

Use a direct/session endpoint for DATABASE_LISTEN_URL with neuton_app credentials. The other runtime URLs may use transaction pooling; all must target the same environment database. The migration owner URL must stay outside API/worker/cleanup runtime credentials. Connections verify TLS certificates.

An existing role with unsafe permissions causes provisioning to fail without changing it. Inspect and correct that role deliberately outside application startup. Do not copy an owner URL into a runtime setting to bypass missing grants.

`neuton_maintenance` is a separate NOLOGIN function owner for bounded cleanup, job bookkeeping and sync/global-price triggers. It receives only their required grants, including DELETE/expiry-column access for old internal records; it cannot read credential hashes or session bearer digests. Runtime roles cannot assume it. This adds no login credential or environment setting. Provisioning and migration share one transaction advisory lock.

User/shop authorization guards take shared transaction advisory locks in user → shop order. Auth revocation must take the matching exclusive `neuton:user:<UUID>` guard before updating the user/session rows. Membership transitions take the actor's user guard, then the exclusive `neuton:shop:<UUID>` guard before shop/member row locks. This lets the SELECT-only policy reader protect authorization without granting it UPDATE access to auth tables. Do not replace those guards with non-local settings or move external service calls inside their transactions.

Provisioning refuses a database with application relations. Run it before the baseline, while the new environment is empty; it is not a repair command for a running database. Existing extension-owned relations do not count as application data.

[Neon's role documentation](https://neon.com/docs/manage/roles) distinguishes console/API-created elevated roles from restricted SQL-created roles. This command uses SQL-created roles. No live database was provisioned as part of source implementation; execute the command against the intended fresh environment with its supplied credentials.
