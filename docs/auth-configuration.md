# Auth migration configuration

`readAuthConfig` in `src/config/auth.ts` reads a supplied environment map and never opens files. Process entry points call it explicitly. It is additive during the migration; the old runtime loader is retired when its consumers move. No owner connection is a fallback for a runtime connection.

| Process | Required migration settings |
|---|---|
| API | APP_ORIGIN, DATABASE_URL, AUTH_DATABASE_URL, CLEANUP_DATABASE_URL, DATABASE_LISTEN_URL, Google, SMTP and encryption/rate-limit settings below |
| Worker | WORKER_DATABASE_URL; existing queue/storage/model settings remain process-specific |
| Cleanup | CLEANUP_DATABASE_URL; storage credentials only when deleting stored objects |
| Migration | MIGRATION_DATABASE_URL only; no Google, mail, Redis, storage or API credentials |

`npm run db:migrate` loads `Neuton-Back/.env` when run from the backend directory.
Existing terminal environment variables take precedence. Only the migration
entry point performs this loading; importing configuration or connection factories
does not open environment files or initialize the API.

Database URLs must use PostgreSQL, include credentials and a database name, and must not request insecure SSL modes. Connection factories enforce certificate validation. Runtime usernames must be exactly neuton_app, neuton_auth, neuton_worker or neuton_cleanup for their respective settings. The migration owner must be separate. DATABASE_LISTEN_URL uses neuton_app with a direct/session endpoint; a Neon pooler endpoint is rejected.

The pinned postgres-js 4.0.0 driver supports SCRAM-SHA-256-PLUS. All runtime,
migration, provisioning and notification connections require channel binding
(`channel_binding: 'require'`) and verified TLS certificates. The URL may retain
`channel_binding=require`; omitted URL settings still use the required policy.
Explicit `prefer`/`disable`, duplicates and arbitrary startup/role overrides are
rejected. Accepted URL options are sslmode, sslrootcert=system and
channel_binding=require. No connection silently falls back to unbound login.

Connection factories set `infer: true` to preserve v3 parameter typing while
upgrading the transport. Drizzle retains its existing timestamp/date and decimal
mappings. Notifications use the same v4 transport on a dedicated session with
pool size one and disabled idle/lifetime retirement; they mark streams unavailable
on disconnect and reconcile after an explicit restart. No environment values
were inspected while making this upgrade.

Primary upgrade reference: [postgres-js v4 upgrade guide](https://github.com/porsager/postgres/tree/v4.0.0#upgrading-from-v3).

APP_ORIGIN is an exact origin without path/trailing slash/credentials. HTTPS is required except explicit development/test localhost HTTP. CORS/CSRF origins derive from that single origin. The environment identifier and Redis auth namespace derive deterministically from NODE_ENV plus APP_ORIGIN. Expose only the environment identifier in the public session response for browser partitions; never expose private configuration.

Google uses GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI. The redirect must equal APP_ORIGIN followed by `/api/v1/auth/google/callback`.

SMTP uses SMTP_HOST, SMTP_PORT, SMTP_SECURE (literal true/false), SMTP_USER, SMTP_PASSWORD and MAIL_FROM. Port 465 requires implicit TLS. Other ports use mandatory STARTTLS; the dispatcher must never downgrade to plaintext. MAIL_FROM accepts an email address or a display name followed by an address in angle brackets, without header newlines.

AUTH_ENCRYPTION_ACTIVE_KEY_ID selects a key in AUTH_ENCRYPTION_KEYS, a JSON object of identifier to canonical base64-encoded 32-byte key. Accept at most eight keys, with bounded simple identifiers. AUTH_RATE_LIMIT_SECRET is a separate canonical base64-encoded 32-byte secret and cannot equal any encryption key. Keep old decryption keys until their pending records have expired or been removed. Never log the config object or its parsed key buffers.

`AUTH_POLICY` centrally defines fixed bounded lifetimes, password/Argon2 parameters, concurrency, abuse windows, transport limits, cleanup retention and redirect paths. No missing or invalid setting disables a protection. Configuration errors disclose only the setting name.

No environment files were inspected while implementing these contracts. Required names are documented here instead of modifying existing environment files. Values are supplied by the operator; their presence is not inferred by reading a file.

## Runtime and focused dependencies

Node 22+ is required. The lockfile pins argon2 0.45.2, openid-client 6.8.9, nodemailer 10.3.1 and cookie 2.0.1. Argon2 requires a native binary for the deployment platform; its package provides supported prebuilt binaries and documents the compiler prerequisites if a source build is needed. No global compiler/tool installation is part of this migration.

The ports in `src/modules/auth/auth.ports.ts` expose password operations, validated Google identity claims, SMTP message delivery and private auth transactions. Accounts and session lifecycle remain Neuton-owned. The public session/membership interfaces live in `src/modules/auth/contracts.ts`.

## Cryptographic and input boundaries

`crypto.ts` generates canonical 32-byte base64url secrets. Persist only purpose-bound SHA-256 digests for bearer credentials. Rate dimensions use a separate HMAC key and include the environment and dimension in their input. Reversible encryption is limited to pending mail payloads and OAuth PKCE verifiers: AES-256-GCM with a fresh 12-byte nonce, 16-byte tag, and associated data containing the envelope version, key ID, purpose and record ID. Tampered or unavailable payloads fail with a bounded 503 error without returning partial plaintext.

To rotate encryption keys, retain the old entry in AUTH_ENCRYPTION_KEYS and select a new active ID. New records use the new key; existing records decrypt only through their explicit saved key ID. Remove old entries only after all pending records using them have expired or been discarded and cleared. The longest confirmation/email-change lifetime is one day; OAuth records last ten minutes. Record expiry is enforced by their lifecycle repositories and dispatcher, not inferred from the key label. Reusing another key ID never recovers an envelope bound to the original ID.

Email input retains its trimmed display form and normalizes its domain through IDNA and the whole account address to lowercase. Dots and plus suffixes remain significant. Unquoted local parts, including valid Unicode, are supported within SMTP address length bounds; control characters, malformed Unicode, IP literals and malformed domains are rejected. Passwords preserve exact input, including spaces and combining characters; 15–128 Unicode code points are required. Strict auth request schemas reject unrecognized fields.

`ArgonPasswordHasher` uses library-generated salts with Argon2id (64 MiB, three iterations, parallelism one). A shared process counter caps concurrent hash/verification work at four without a waiting queue. Overload or native failures return a bounded 503. Unknown-account comparisons use a fixed synthetic dummy hash whose result is always discarded. Hashing and comparison happen outside database transactions.

Primary cryptographic APIs: [Node 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html), including createCipheriv/createDecipheriv, setAAD, authentication tags, randomBytes and timingSafeEqual. Password primitives use the pinned node-argon2 adapter above.

## Account email delivery

`MailOutboxRepository` inserts encrypted subject/text content in the same locked account transaction as its action. It rechecks the saved action digest, purpose, destination, account status, security version and expiry before enqueueing. Reset messages additionally require an existing password credential. The plaintext destination is required for delivery; the secret-bearing body is AES-GCM encrypted with the outbox UUID and purpose as associated data. Security notices contain no consumable token and use the account's current contact address.

Templates use only APP_ORIGIN plus `/auth/confirm`, `/auth/reset-password` or `/auth/email-change`, with `#token=` fragments. No request supplies a redirect or mail origin. GET links never consume their token.

`SmtpAuthMailer` uses the configured Brevo credentials through Nodemailer. Port 465 uses implicit TLS; other configured ports require STARTTLS, with certificate validation and TLS 1.2 minimum. Connection, greeting, DNS and socket timeouts use the central 30-second policy. SMTP logging/debug/transaction logging are disabled; file and URL content loading are disabled; messages have one explicitly constructed recipient and configured sender. Errors expose only MAIL_DELIVERY_UNAVAILABLE, and no provider response is attached. A stable outbox-based Message-ID does not imply SMTP deduplication or guarantee inbox delivery. The durable dispatcher owns retry and completion bookkeeping.

Transport options follow the [official Nodemailer SMTP documentation](https://nodemailer.com/smtp) and the pinned package declarations.

`MailDispatcher` claims only immediately available send capacity (two rows), up to 25 per drain, using SKIP LOCKED and per-record UUID lease tokens. It rechecks account/action state under the matching user guard, then releases SQL before SMTP. One-minute leases are renewed during delivery. Completion/retry checks the current lease token and deadline; an old process cannot complete a reassigned record. Successful or discarded rows erase encrypted payloads. Retry delay starts at 30 seconds, doubles to a one-hour cap, and never extends the record's original expiry. SMTP's ambiguous acceptance window may still produce a duplicate message.

`AuthModule.forRoot` receives a configuration factory, API logger, Redis URL and application database explicitly. Its runtime starts dispatch through the Nest initialization hook and drains active sends before closing SMTP, Redis and auth connections through the destruction hook. Module import alone reads no environment and creates no clients. The API root installs this module alongside the business modules. Supabase credentials are no longer runtime requirements for the backend.

Primary references consulted: [pinned Argon2 documentation](https://github.com/ranisalt/node-argon2/blob/v0.45.2/README.md), [openid-client](https://github.com/panva/openid-client), and the installed packages' manifests and declarations. The cookie 2 API uses parseCookie/stringifySetCookie; SMTP 10 includes its own TypeScript declarations.
