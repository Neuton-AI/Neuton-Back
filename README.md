# Neuton-Back

Neuton owns password/Google accounts and opaque cookie sessions. Start with
[auth setup and operations](docs/auth-setup.md) for fresh Neon projects, restricted
roles, migration-only commands, mail, key rotation and one-origin hosting.

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
processes. Deliberately apply the committed `drizzle-neon/` chain before deploying.
`npm run build` clears `dist/` before compilation so retired modules cannot remain
in deployment output. Use the npm command when preparing the production bundle.
The old chain is preserved in `drizzle-archive/` and is never active discovery.
Storage/auth cleanup and durable mail dispatch follow the API lifecycle;
leased work survives restarts. Startup never migrates the database.

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
`GET /api/v1/sync/events` SSE endpoint.
The database hosting provider can change without changing the sync protocol.

The active Neon baseline includes document notifications. `DATABASE_LISTEN_URL`
is mandatory and uses a dedicated direct/session connection as `neuton_app`;
transaction-pooled URLs and fallback URLs are rejected. The listener needs
permission to connect and LISTEN; migration-only execution uses the separate
owner. No replication slot, publication or provider extension is required.
Keep database credentials on the backend.

Proxies must allow streaming responses, disable SSE buffering and permit an idle
connection for longer than the 15-second heartbeat interval. Browser fetch uses
HttpOnly session cookies and x-shop-id, without bearer authorization. Browser
traffic uses the same origin; CORS/CSRF derive from exact APP_ORIGIN.
Session/membership is checked before each forwarded
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

Verification: `npm run verify` and `npm run db:validate`. The sync/base-version
integration checks use the development Neon connections described below.
Native commit/rollback/fan-out/reconnect tests use `DATABASE_LISTEN_URL`.
Never use production connections for these tests. See
[SPEC-183-live-document-sync.md](./SPEC-183-live-document-sync.md) for acceptance
criteria. Roll back frontend/backend together to restore the old comparison
triggers; the additive notification trigger may remain, or remove it and
`notify_document_change()` after stopping all listeners. Retain version tables
and offline queues during rollback.

## Development database integration tests

The prepared development Neon database also serves as the test database. Run
`npm test` or `npm run verify` from this directory with its existing role settings:
`DATABASE_URL` (`neuton_app`), `AUTH_DATABASE_URL` (`neuton_auth`), and
`MIGRATION_DATABASE_URL` (the separate schema owner). The database must already
have the current `drizzle-neon` chain applied; tests do not provision roles or
run migrations against it. Never use production settings for these commands.

Order numbering/transitions, catalog, inventory batches, tenant links, document
sync, base revisions, receipt inventory, worker deletion and signed downloads
share `scripts/support/neonFixture.ts`. It checks that all three
connections target the same database, creates unique accounts/sessions and a
shop, and removes only those fixtures in `finally`. Owner access is used for
fixture setup/cleanup and fault injection; application operations run through
the real restricted app connection and verified user/shop scopes. The tests
skip explicitly when those development settings are absent, so offline CI can
still run without credentials. The old `*_TEST_DATABASE_URL` settings are no
longer used. Worker-deletion checks additionally use `WORKER_DATABASE_URL`;
native notification checks use the direct `DATABASE_LISTEN_URL`. Both retain
their restricted runtime roles. The notification test terminates only its own
uniquely named listener connections when verifying reconnect behavior.

`npm run db:verify-rls` uses the same development connections to check forced
RLS, the restricted app role, cross-shop access, member permissions and immutable
upload sources with fresh, automatically cleaned fixtures. Historical migration
regression SQL in recipe/receipt tests runs only against owner-only,
connection-local temporary tables. Historical malformed recipe links are also
simulated in a temporary table without corrupting public data. Signed-download checks generate signatures locally; no test
objects are uploaded to or removed from storage.
