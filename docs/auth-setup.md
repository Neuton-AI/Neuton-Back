# Neuton-owned auth setup and operations

Use Node 22+ and `npm ci` in each repository. The API, worker and migration
commands run from `Neuton-Back`; frontend commands run from `Neuton-Front`.
Supply credentials through each process's environment or its operator-managed
local environment file. Never commit, print or copy secret values into this guide.

## Fresh database and migration-only execution

Development and production use separate fresh Neon projects. Existing external
accounts, sessions, business rows and migration ledgers are not imported. Users
register fresh accounts and create shops. There is no default account or password.

1. Supply `MIGRATION_DATABASE_URL` for the target's separate migration owner.
   Run `npm run db:provision`. This command uses the process setting or a hidden
   prompt; it does not load a local environment file. It creates/validates four
   restricted LOGIN roles and three NOLOGIN helper owners, revokes public grants
   and gives the migration owner the required helper-role access. It does not
   print generated role passwords or overwrite existing ones.
2. Set/reset the four LOGIN passwords through Neon administration. Supply the
   role-specific URLs below for that same environment/database. Runtime roles
   must have no owner membership, superuser, role-creation or RLS-bypass power.
3. Run `npm run db:validate`, then deliberately run `npm run db:migrate` with the
   migration-owner setting. The migration entry point loads the backend's local
   environment file with existing process variables taking precedence. Apply
   exactly the committed `drizzle-neon/` chain, currently through
   `0015_auth_cleanup.sql`, independently in each environment.
4. Run development verification using development credentials only. API startup
   never provisions, resets or migrates the database. Do not supply migration
   credentials to deployed API/worker processes.

`drizzle.config.ts`, the guarded runner and validator discover only `drizzle-neon`.
The runner uses an advisory lock, transactional DDL, the `neuton-auth-neon-v1`
baseline marker and a checksummed unchanged-prefix ledger. Initial application
relations, either legacy ledger, incompatible markers, missing history or changed
checksums cause refusal. Investigate refusals; never edit the ledger to force a
match. `drizzle-archive/` preserves the historical SQL and metadata for reference.
Three regression tests run archived SQL only against connection-local temporary
tables. Never replay the archive against application tables. Generate/review new
numbered migrations with the migration configuration; do not edit applied SQL.

## Process settings and connection roles

| Setting | Consumer and authority |
| --- | --- |
| `DATABASE_URL` | API business transactions as `neuton_app` |
| `AUTH_DATABASE_URL` | API account/session/auth and mail outbox as `neuton_auth` |
| `WORKER_DATABASE_URL` | Separate media worker as `neuton_worker` |
| `CLEANUP_DATABASE_URL` | API storage/auth cleanup through restricted `neuton_cleanup` routines |
| `DATABASE_LISTEN_URL` | Mandatory dedicated direct/session endpoint as `neuton_app`; no transaction pooler or fallback |
| `MIGRATION_DATABASE_URL` | Provisioning/migration owner only |

`neuton_policy_reader`, `neuton_bootstrap` and `neuton_maintenance` are NOLOGIN
function owners, never runtime credentials. Connections verify TLS certificates
and require channel binding. Runtime URLs cannot substitute an owner or another
process's setting. See [configuration](auth-configuration.md) for URL validation.

The API additionally needs `APP_ORIGIN`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`,
`AUTH_ENCRYPTION_ACTIVE_KEY_ID`, `AUTH_ENCRYPTION_KEYS` and
`AUTH_RATE_LIMIT_SECRET`. Retain existing `UPSTASH_REDIS_URL`, R2 account/key/
bucket settings and `GEMINI_API_KEY` for the processes using queue/storage/model
services. Optional log settings and bounded runtime controls are defined in
`src/env.ts`. Only role-specific Neon URLs are used; owner-URL fallbacks are unsupported.

Use Brevo's SMTP relay with a verified sender/domain and operator-supplied SMTP
credentials. Port 465 uses implicit TLS; port 587 uses mandatory STARTTLS with
`SMTP_SECURE=false`. Do not downgrade certificate/TLS checks. Development sends
go only to approved test recipients. SMTP rejection remains a delivery failure;
the durable encrypted outbox retries the same valid message under bounded leases.

Register the exact Google callback `APP_ORIGIN/api/v1/auth/google/callback` for
each environment's own OAuth client. Request only OpenID/email/profile access.
Login/link/reauthentication use top-level browser navigation and a fixed completion
route. New Google accounts still confirm local contact email. Missing or stale
Google authentication-time assurance cannot grant recent authentication. Live
consent and authentication-time behavior must be verified with the configured
client before hosted launch.

Encryption settings use a versioned JSON keyring of canonical base64 32-byte
keys, an active ID, and a distinct 32-byte rate-limit secret. Deploy new active
keys while retaining old keys referenced by pending mail/verifiers; drain those
references before removal. Follow [retention and rotation](auth-retention.md),
including aggregate checks and forward rollback. Never expose key material.

## Runtime lifecycle and environment separation

Build with `npm run build`. Run `npm start` and `npm run start:worker` separately
(development: `npm run dev` and `npm run dev:worker`). AuthModule starts the leased
mail dispatcher with the API and drains it before closing SMTP/auth/Redis clients.
The API starts storage cleanup and bounded auth cleanup after listening, stops
dispatchers on shutdown and drains work before closing the cleanup pool. Auth
cleanup runs every minute; it needs neither encryption nor Google/SMTP secrets.
Monitor bounded cleanup/mail failure events and backlogs; delayed cleanup does
not extend access-time expiry. The worker recovers persisted publication, handles
media outside SQL transactions, and reauthorizes each commit. Logout preserves
accepted jobs; disablement/membership/resource invalidation prevents later writes.

Separate all environment origins, databases, role passwords, Google clients,
SMTP recipients, keyrings, rate-limit secrets, storage buckets and Redis data.
Auth limiter keys derive `neuton:auth:<environment>` from mode and application
origin. BullMQ uses the fixed `neuton-media` queue name: use separate Redis
instances/databases for environments; the auth namespace does not isolate queues.
Keep `QUEUE_OPTIONAL` disabled for normal deployments. Runtime startup must fail
when a required role/service setting is absent; never copy owner credentials to
make a runtime role work.

## Browser origin, hosting and logging

Local browser traffic uses `http://localhost:5173`; Vite proxies `/api` to the
API on port 4000. `APP_ORIGIN` must match exactly, without a path/trailing slash.
Do not mix localhost and 127.0.0.1. Hosted installations require one HTTPS origin:
route `/api/*` to the API before the static SPA fallback, including the Google
callback. Preserve cookies, `Set-Cookie`, Origin, CSRF/shop headers and response
status. Never cache API/session/security responses or apply a static rewrite to
them. Cloudflare Pages hosting also needs an actual API proxy/Worker route;
static SPA fallback alone cannot provide cookie auth.

Forward `/api/v1/sync/events` as a streaming response: disable proxy buffering
and caching and allow idle time longer than the 15-second heartbeat. Forward
disconnects; heartbeats do not renew sessions. Trust only explicitly configured
proxy addresses/subnets. Apply the frontend's `_headers` rules (or equivalent
host configuration) to actual SPA responses, including direct auth/action routes.
Verify CSP, restrictive referrer behavior, no-store and online action-route
delivery at the hosted origin. The frontend README describes allowed resources.

Redact cookies, Set-Cookie, Authorization, CSRF headers, passwords, action tokens,
Google codes/state/tickets, signed URLs and email-link URLs at API, proxy, CDN,
error-reporting and telemetry layers. Do not record raw query strings, fragments,
request/response bodies or provider failures for auth routes. Log bounded event
codes and correlation IDs instead. Browser secrets stay in transient memory;
HttpOnly session cookies never become JavaScript state.

Old browser partitions remain quarantined. They cannot be relabeled or uploaded
into fresh accounts, even with matching emails. The app offers explicit legacy
discard; preserve current unsent work under its original environment/user/shop.
Production runs the same reviewed chain with separately supplied credentials.
This guide and Phase J implementation do not perform a production cutover.
