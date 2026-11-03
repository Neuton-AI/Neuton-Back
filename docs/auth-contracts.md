# Neuton authentication contracts

Migration: Neuton-AI/Neuton-Back#195, Phase A. These contracts describe the target implementation. The existing Supabase runtime is replaced in later phases, not enabled alongside a second authority.

## Authority and boundaries

The browser supplies cookies, form inputs and an untrusted `x-shop-id` selection. PostgreSQL establishes current account, session and membership validity. The API never accepts a user ID, role, security version or confirmation flag as authentication. Redis only limits abuse; Google only establishes an external issuer/subject. Neither is a local account/session authority.

The auth pool accesses `auth_private`; business repositories receive scoped capabilities from the app pool. Runtime processes never use the migration owner. Queue messages identify persisted jobs, not their permissions. Private auth relations are excluded from general business-schema exports and DTOs.

## Public DTOs

Use one `SessionDto` and one `ShopMembershipDto`. UUIDs below are internal identifiers. All timestamps are UTC ISO 8601 strings, all monetary shop settings are decimal strings.

```ts
type ShopRole = 'owner' | 'admin' | 'member';
type SessionDto = {
  environment: string;
  user: {
    id: string;
    email: string;
    fullName: string | null;
    avatarUrl: string | null;
    status: 'pending_email' | 'active';
    emailConfirmedAt: string | null;
  };
  session: {
    id: string;
    idleExpiresAt: string;
    absoluteExpiresAt: string;
    recentAuthenticationExpiresAt: string | null;
    renewAfter: string;
  };
  memberships: ShopMembershipDto[];
};
type ShopMembershipDto = {
  shopId: string;
  role: ShopRole;
  shop: {
    id: string;
    name: string;
    slug: string;
    currency: string;
    timezone: string;
    storeAddress: string | null;
    targetProfitMargin: string;
    hourlyLaborCost: string;
    deliveryBaseFee: string;
    deliveryRatePerKm: string;
  };
};
```

Pending-email sessions have an empty membership list. Construct their safe projection using the auth repository; never enter an active-user tenant transaction. Disabled/expired/revoked sessions yield 401; database failure yields 503. `/session` does not renew activity. No response contains cookie values, bearer digests, password hashes, provider tokens or IP metadata. All account/session responses use `Cache-Control: no-store`.

The existing backend `{role, shop}` membership response and frontend `{shopId, role, shops}` expectation are replaced together through the central membership adapter; no two public shapes remain.

## HTTP ownership

All routes use `/api/v1`. `AuthController` owns `/session` and `/auth/*`; remove the existing `ShopsController.session` when wiring the new controller. The shops password route delegates to the local password service. Preserve existing business route paths and role restrictions.

| Method and path | Input | Result and capability |
|---|---|---|
| POST /auth/csrf | No account identifiers | `{csrfToken}`; exact origin/browser metadata; browser context or session binding |
| POST /auth/register | email, password, optional fullName | Generic 202; pre-auth CSRF |
| POST /auth/login | email, password | 204 and new cookie; pre-auth CSRF |
| GET /session | Cookie | SessionDto; 401 anonymous, 503 unavailable |
| POST /auth/email/resend | email | Generic 202; pre-auth or restricted pending-account CSRF |
| POST /auth/email/confirm | token | 204; browser-context CSRF; normal login afterward |
| POST /auth/session/renew | No identity fields | 204; session CSRF; capped sliding expiry |
| POST /auth/logout | No identity fields | 204 and expired cookie only after revocation commits |
| POST /auth/logout-all | No identity fields | 204; session CSRF; global revocation |
| GET /auth/sessions | Cookie | Own bounded device descriptors with internal IDs only |
| DELETE /auth/sessions/:id | Owned session UUID | 204; session CSRF |
| POST /auth/password/recovery | email | Generic 202; browser CSRF |
| POST /auth/password/reset | token, password | 204; browser CSRF; normal login afterward |
| POST /auth/reauthenticate/password | password | 204 and replacement cookie; session CSRF |
| POST /profile/password | currentPassword, newPassword | 204 and replacement cookie; session CSRF |
| POST /auth/password/add | password | 204 and replacement cookie; recent Google proof |
| POST /auth/google/start | purpose, returnPath | `{authorizationUrl}`; CSRF; initiating session for link/reauthenticate |
| GET /auth/google/callback | code/state or provider denial | Fixed completion-page redirect; state/nonce/PKCE/browser binding |
| POST /auth/google/complete | ticket | `{returnPath}` and permitted new cookie; browser/session CSRF as appropriate |
| GET /auth/methods | Cookie | Available password/Google methods; no protocol secrets |
| DELETE /auth/methods/google | No identity fields | 204; recent proof and remaining password method |
| POST /auth/email/change | email | 202; active account, recent proof and CSRF |
| POST /auth/email/change/confirm | token | 204; same account, recent proof, CSRF; normal login afterward |

Errors retain `{error:{code,message,traceId}}`. Use 400 malformed input, 401 invalid authentication, 403 forbidden/CSRF, 409 authenticated disclosable conflicts, 429 limited, 503 dependency failure. Registration/recovery/resend do not disclose account existence/status.

## Browser transport and redirects

Every browser mutation requires the exact configured `APP_ORIGIN`, supported content type, and `x-csrf-token`. Reject missing/null origins. Callback GET is the narrow state-bound exception. CSRF bootstrap also enforces browser metadata; a public CSRF token never authorizes an account. Reissue CSRF after session replacement; retain it in memory only.

HTTPS uses `__Host-neuton-session`, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. Local HTTP uses a distinct development name and is allowed only for development/test localhost. Local browser origin is `http://localhost:5173`, with `/api` proxied to the API. Hosted frontend/API share one HTTPS origin.

Return paths are exact local routes from the configured allowlist, initially `/`, `/dashboard`, `/profile`; reject external URLs, protocol-relative paths, backslashes, fragments and unapproved queries. The flow stores the approved path server-side. Completion always redirects to `/auth/google/complete`; email confirmation, reset and change use fixed `/auth/confirm`, `/auth/reset-password` and `/auth/email-change` pages. Transient fragments are stripped before ordinary app/telemetry startup. GET never consumes an action secret.

## Internal transaction capabilities

An authenticated user capability carries the Drizzle transaction, verified internal user/session IDs and no shop. A shop capability adds the membership's current shop/role. A worker capability comes from the persisted job authorization and includes job ID, requesting user, resource and allowed operation. Distinct types prevent accepting a browser DTO as proof.

`withUserTransaction`/`withShopTransaction` establish parameterized transaction-local user/session/shop settings before protected SQL. The selected shop is empty in a user transaction. Validate current account/session/security version and current membership inside that transaction. Pass the same handle through audit, versioning, mutation responses and savepoints. Lock order: user security row, session/credential/OAuth rows, shop, membership, resource. Sensitive revocation/transitions acquire conflicting locks in that same order.

No lock or transaction spans Google, SMTP, R2 or model calls. Read authorized input, end the transaction, call the service, then reauthorize in a new transaction before writes. Device logout does not cancel accepted jobs, but account disablement, membership loss, resource invalidation or explicit cancellation does. Streams reauthorize before each hint and at least every 15 seconds.

## Browser identity and offline state

OAuth completion records reference an existing target user or reserve a server-generated candidate UUID for a new account, exclusively. The latter has no user FK until the completion POST creates the account; callback GET does not have to create an account to satisfy a premature FK. Store only the validated identity claim allowlist, never Google tokens. Completion rechecks email collisions, initiating session and security version under locks before applying the mapping.

One provider exposes loading, anonymous, pending-email, authenticated and unavailable. Unavailable is not confirmed logout or fresh authority. Cold offline startup remains locked. Partitions are environment + verified user UUID + shop UUID and survive ordinary session replacement. Legacy partitions are quarantined; never infer new ownership from email. Stop requests/subscriptions and clear transient caches before showing a different account. Preserve unsent edits in their original partition; never replay them under another user.
