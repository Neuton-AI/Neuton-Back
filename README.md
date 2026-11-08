# Neuton-Back

## Runtime and module boundaries

The API runs on NestJS with Express. `src/app.ts` composes identity, shops,
inventory, recipes, categories, orders, receipts, uploads, analytics and synchronization. Controllers
validate contracts and pass authenticated context into application services;
persistence owns tenant-scoped database access and explicit public mapping.
Sync calls transaction-bound services directly. The BullMQ adapter calls the
document-processing service through a queue-independent progress interface.

`InventoryModule` owns stock CRUD, filtering, and idempotent adjustments.
`RecipeModule` owns recipe CRUD, verification, costing, manual products,
barcode prices, and deletion. `CategoriesModule` owns the category endpoints
used by both domains. Each module has its own contracts and persistence;
inventory and recipes do not import each other's application code. They share
database types and audit infrastructure. Recipe costing still reads linked
inventory data through the existing tenant-scoped queries.

See [the module separation decision](docs/decisions/0001-separate-inventory-recipes.md).

Run `npm run build`, then `npm start` and `npm run start:worker` as separate
processes. Apply all pending migrations, including
`0030_storage_object_deletions.sql`, before deploying. Start and stop storage
cleanup with the API process; leased cleanup work survives restarts.

Query parameters use camelCase only. Delivery preview uses `distanceKm`.
Catalog boolean flags accept `true`/`false`; the string `false` keeps filters
disabled. Stock adjustments require a UUID `Idempotency-Key`: create one key
per intent and reuse it after timeouts or an unknown response. Uploads use
the grouped presign/complete flow exclusively, including single-image uploads.

`TRUST_PROXY` is an explicit comma-separated list of deployment proxy addresses
or subnets; an empty value trusts none. Configure the actual proxy topology
before deployment. `RATE_LIMIT_WINDOW` accepts a positive duration such as
`1 minute` or `30 seconds`. Signed-webhook raw bytes are retained by the shared
HTTP setup. Request/trace IDs and safe error diagnostics accompany responses.

See [migration and rollout notes](docs/nestjs-migration.md) and the
[implementation plan](tasks/plan.md) for verification evidence and rollback.

## Account authentication

Neuton stores credentials, display names, and avatars in `public.users`.
The profile endpoints read and edit fields on that account row.

Back up the database and stop the API and worker before running
`npm run db:migrate`. Migration `0034` copies profile details for existing
Neuton accounts and drops `public.profiles`. Memberships for Neuton accounts
are kept. Legacy-only profiles and their memberships are removed, and
nullable user references on their business records are cleared. Start the
updated API and worker after the migration. To roll back, restore the
pre-migration database snapshot and its matching app version.

Set `NEUTON_JWT_SECRET` to a random 32-byte hex value on the server. Use the
same value across API instances. Changing it expires every issued token.

```sh
node -p "require('node:crypto').randomBytes(32).toString('hex')"
```

| Endpoint | Body | Success |
| --- | --- | --- |
| `POST /api/v1/auth/signup` | `{ email, password, fullName? }` | `201 { token, user }` |
| `POST /api/v1/auth/signin` | `{ email, password }` | `200 { token, user }` |
| `GET /api/v1/session` | Bearer token | `200 { user, memberships }` |

Signup trims and lowercases emails. New passwords must contain 8–128
characters. Duplicate emails return `409`, and invalid sign-in credentials
return `401`. Authentication and password changes share a per-IP limit of
12 requests per minute. Send the one-hour JWT as `Authorization: Bearer <token>`.
Shop-scoped routes still require `x-shop-id` and verify membership.

Set `AUTH_TEST_DATABASE_URL` to a migrated disposable PostgreSQL database to
run the account and tenant-access integration test.

## Verification endpoints

All verification actions are domain-specific POST requests under `/api/v1`.

| Endpoint | Request body | Result | Required shop role |
| --- | --- | --- | --- |
| `/receipts/:id/verify` | `{ items: [{ id, accepted, ...corrections }] }` | Receipt becomes `verified`; accepted lines update inventory. Unit corrections use `srcUnit`. | Owner or admin |
| `/recipes/:id/verify` | `{}` or `{ ingredients: [...] }` | Recipe becomes `verified`; supplied ingredients replace the extracted lines in the same transaction. | Owner or admin |
| `/orders/:id/verify` | No body required | Order moves from `processing` to `delivered`. | Any shop member |

The old `POST /catalog/:type/:id/verify` and `PATCH /orders/:id/status` routes
have been removed. Deploy clients using the domain endpoints together with this
server change. Response shapes and verification permissions are unchanged.

Receipt verification copies `rawMaterialName`, `baseUnit`, and `baseUnitAmount`
from each accepted receipt line into its inventory item. Those fields, plus
`baseUnitCost`, can also be supplied as optional line corrections. Base unit
cost defaults to the corrected `unitPrice / baseUnitAmount` and is saved with
six decimal places; an explicit zero amount produces a zero cost. When an older
extraction has no measurements, verification retains the inventory item's
package measurement (one source unit for a new item). Stock quantities and
weighted average purchase costs continue to use the receipt's purchase units.
An extraction that names a different base unit without an amount saves zero
amount and cost until a complete measurement is supplied.

Apply `0023_receipt_item_raw_material_name.sql` before deploying this version.
It backfills existing receipt lines from `raw_name` before making the new
material name required.

## Supermarket search (Scrapy-API)

The API and worker use Scrapy-API for receipt enrichment, recipe fallback prices,
and barcode lookup. Configure both processes:

```dotenv
SCRAPY_API_BASE_URL=http://localhost:3000
SCRAPY_API_TIMEOUT_MS=5000
```

These are the defaults. Use the reachable Scrapy-API origin in deployments
(`localhost` refers to the running process's host/container); use HTTPS for a
remote service. The timeout covers response headers and the JSON body and may
be configured from 1 to 60000 ms. Check the provider's `/health/ready` endpoint
before deploying. Search needs no HTTP credentials. No database migration is
required for Neuton.

`GET /v1/search` always sends `limitPerChain=10` and an explicit `queryType`:
`sku` for exact barcodes, `name` for names. SKU strings retain leading zeros;
barcode pricing also tries the EAN-13 equivalent of a zero-padded GTIN-14 when
there is no exact original match. Searches cover every chain returned by the
API rather than a local two-chain list.

Results use the raw camelCase contract: `chainId`, `itemCode`, `itemName`,
`manufactureName`, `itemPrice`, `quantity`, `unitQty`, and `score`. Text money
and quantity values stay strings; nullable columns stay null. Additional
columns are preserved. The client validates required fields and rejects a
malformed response. It does not expect `name`, `price`, or normalized package
fields from the older `ENDPOINTS.md` example. The provider's
`SPEC-raw-row-search.md` and contract tests describe the current contract.

Receipt enrichment tries exact SKU, then exact receipt name, then searches
both the receipt name and raw material name. Those two lists are merged,
sorted by the API's scores, and truncated to five; duplicates remain eligible,
as before. Neuton calculates no product-match scores or thresholds. Recipe
fallback keeps its deterministic selection and package validation, then uses
the shared unit conversion and costing pipeline. Receipt unit voting remains
application logic, independent of product-match scoring.

A successful empty response is `[]`. HTTP errors (including 400, 429, and 503),
network failures, malformed responses, and timeouts raise a typed
`SUPERMARKET_UNAVAILABLE` error; HTTP status, Retry-After seconds, and upstream
request ID are retained for diagnostics. Requests are not automatically retried.
The default search logs failure diagnostics without product queries or response
bodies. Receipt enrichment remains optional, recipe fallback leaves unresolved
lines unlinked, and interactive barcode lookup returns 503 on provider failure
rather than claiming the barcode was not found. A genuine absent barcode is
404; an unusable product measurement or price is 400.

Neuton keeps no XML catalog, catalog volume, catalog download, or local search
fallback. Scrapy-API owns catalog refresh and product matching. Requests use the
single-search endpoint; if batching is added, the provider accepts at most ten
queries per batch. Revert the migration commits together to restore the old
catalog implementation; its persistent `prices/` volume would then be needed.

Verification: `npm run verify` runs source/test type checks, the full suite, and
build. `scripts/scrapy-api.test.ts` covers the HTTP contract and failures;
`scripts/product-search.test.ts` covers receipt orchestration, and the recipe
conversion, fallback, editor, and worker suites cover pricing and persistence.

# Live document synchronization (#183)

Sync uses native PostgreSQL `LISTEN`/`NOTIFY` and our authenticated
`GET /api/v1/sync/events` SSE endpoint. It does not use Supabase Realtime.
The database hosting provider can change without changing the sync protocol.

Apply `0031_native_document_events.sql` with the normal migration runner before
enabling the updated frontend. Set `DATABASE_LISTEN_URL` to a direct or
session-pooled PostgreSQL connection. It defaults to `DATABASE_URL` for direct
database deployments; **transaction-pooled URLs cannot be used for LISTEN**.
The listener needs permission to connect and LISTEN; migrations require the
normal owner privileges. No replication slot, publication or provider extension
is required. Keep database credentials on the backend.

Proxies must allow streaming responses, disable SSE buffering and permit an idle
connection for longer than the 15-second heartbeat interval. Browser fetch uses
the existing Authorization and x-shop-id headers. Authorize origins through the
existing CORS configuration. Session/membership is checked before each forwarded
hint and on heartbeat; a denied session is closed. Source loss closes streams.
Each backend instance listens independently and serves its own browser sessions.

Events are wake-up hints, not a replay log. Startup, focus/resume, browser-stream
reconnect and database-listener reconnect run full version comparison; only
changed complete documents are downloaded. Comparisons chunk requests at 20,000
local metadata records and deduplicate discoveries. This trades metadata scans
for avoiding edit-history storage and commit-order cursors. Keep existing
deletion tombstones; no pruning policy is introduced. Failed work retries with
existing error backoff. There is no periodic successful-state server polling.

Local storage retains pending work, server base snapshots and explicit conflicts.
The optional x-sync-base-version header rejects writes against a changed server
base even when the client timestamp is larger. Replay retains the original
mutation identity. Sync detail reads request x-sync-snapshot: true; the backend
checks the revision before/after reading and returns a matching syncVersion.
Busy documents retry safely rather than persisting a mismatched payload/version.
Deploy the backend before the frontend; older clients remain
compatible but retain their previous conflict semantics. Ingredient/step arrays
without stable identity remain conservative conflict units. Conflicts require an
explicit local/server choice; accepting a remote deletion discards its pending
queue, so export a retained draft first if a copy is needed.

Verification: `npm run verify` and `npm run db:validate`. On a disposable migrated
database, set `SYNC_TEST_DATABASE_URL` for base-version/integration checks and
`NATIVE_SYNC_TEST_DATABASE_URL` for native commit/rollback/fan-out/reconnect tests.
Never point these fixture variables at production. See
[SPEC-183-live-document-sync.md](./SPEC-183-live-document-sync.md) for acceptance
criteria. Roll back frontend/backend together to restore the old comparison
triggers; the additive notification trigger may remain, or remove it and
`notify_document_change()` after stopping all listeners. Retain version tables
and offline queues during rollback.
