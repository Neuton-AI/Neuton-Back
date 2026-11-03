# Auth migration configuration

`readAuthConfig` in `src/config/auth.ts` reads a supplied environment map and never opens files. Process entry points call it explicitly. It is additive during the migration; the old runtime loader is retired when its consumers move. No owner connection is a fallback for a runtime connection.

| Process | Required migration settings |
|---|---|
| API | APP_ORIGIN, DATABASE_URL, AUTH_DATABASE_URL, CLEANUP_DATABASE_URL, DATABASE_LISTEN_URL, Google, SMTP and encryption/rate-limit settings below |
| Worker | WORKER_DATABASE_URL; existing queue/storage/model settings remain process-specific |
| Cleanup | CLEANUP_DATABASE_URL; storage credentials only when deleting stored objects |
| Migration | MIGRATION_DATABASE_URL only; no Google, mail, Redis, storage or API credentials |

Database URLs must use PostgreSQL, include credentials and a database name, and must not request insecure SSL modes. Connection factories enforce certificate validation. Runtime usernames must be exactly neuton_app, neuton_auth, neuton_worker or neuton_cleanup for their respective settings. The migration owner must be separate. DATABASE_LISTEN_URL uses neuton_app with a direct/session endpoint; a Neon pooler endpoint is rejected.

APP_ORIGIN is an exact origin without path/trailing slash/credentials. HTTPS is required except explicit development/test localhost HTTP. CORS/CSRF origins derive from that single origin. The environment identifier and Redis auth namespace derive deterministically from NODE_ENV plus APP_ORIGIN. Expose only the environment identifier in the public session response for browser partitions; never expose private configuration.

Google uses GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI. The redirect must equal APP_ORIGIN followed by `/api/v1/auth/google/callback`.

SMTP uses SMTP_HOST, SMTP_PORT, SMTP_SECURE (literal true/false), SMTP_USER, SMTP_PASSWORD and MAIL_FROM. Port 465 requires implicit TLS. Other ports use mandatory STARTTLS; the dispatcher must never downgrade to plaintext. MAIL_FROM accepts an email address or a display name followed by an address in angle brackets, without header newlines.

AUTH_ENCRYPTION_ACTIVE_KEY_ID selects a key in AUTH_ENCRYPTION_KEYS, a JSON object of identifier to canonical base64-encoded 32-byte key. Accept at most eight keys, with bounded simple identifiers. AUTH_RATE_LIMIT_SECRET is a separate canonical base64-encoded 32-byte secret and cannot equal any encryption key. Keep old decryption keys until their pending records have expired or been removed. Never log the config object or its parsed key buffers.

`AUTH_POLICY` centrally defines fixed bounded lifetimes, password/Argon2 parameters, concurrency, abuse windows, transport limits, cleanup retention and redirect paths. No missing or invalid setting disables a protection. Configuration errors disclose only the setting name.

No environment files were inspected while implementing these contracts. Required names are documented here instead of modifying existing environment files. Values are supplied by the operator; their presence is not inferred by reading a file.

## Runtime and focused dependencies

Node 22+ is required. The lockfile pins argon2 0.45.2, openid-client 6.8.9, nodemailer 10.3.1 and cookie 2.0.1. Argon2 requires a native binary for the deployment platform; its package provides supported prebuilt binaries and documents the compiler prerequisites if a source build is needed. No global compiler/tool installation is part of this migration.

The ports in `src/modules/auth/auth.ports.ts` expose password operations, validated Google identity claims, SMTP message delivery and private auth transactions. Accounts and session lifecycle remain Neuton-owned. The public session/membership interfaces live in `src/modules/auth/contracts.ts`.

Primary references consulted: [pinned Argon2 documentation](https://github.com/ranisalt/node-argon2/blob/v0.45.2/README.md), [openid-client](https://github.com/panva/openid-client), and the installed packages' manifests and declarations. The cookie 2 API uses parseCookie/stringifySetCookie; SMTP 10 includes its own TypeScript declarations.
