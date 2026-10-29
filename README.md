# Neuton-Back

## Runtime and module boundaries

The API runs on NestJS with Express. `src/app.ts` composes identity, shops,
catalog, orders, receipts, uploads, analytics and synchronization. Controllers
validate contracts and pass authenticated context into application services;
persistence owns tenant-scoped database access and explicit public mapping.
Sync calls transaction-bound services directly. The BullMQ adapter calls the
document-processing service through a queue-independent progress interface.

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

## Supermarket catalog cache

Product searches keep decoded XML in `<backend-root>/prices/shufersal/<unix-ms>.xml`
and `prices/carrefour/<unix-ms>.xml`. The path is relative to the module installation,
not the launch directory, for both `tsx src/worker.ts` and `node dist/worker.js`.
The timestamp is download completion time. Files expire at exactly six hours;
expired or corrupt catalogs are removed before refresh. A failed chain is logged
with its cache path and does not suppress results from the other chain.

Provision writable, persistent storage at `<backend-root>/prices` (for example a
container volume). Deployments must include the backend directory layout above;
ephemeral disks work but lose the cache on restart. No new environment variable
is required. Generated files are ignored by Git. Each process holds one parsed
catalog per chain in memory while its file is unchanged and fresh.

BullMQ receipt concurrency and concurrent item enrichment share one in-process
promise per chain. Separate processes sharing the same volume coordinate through
`proper-lockfile` directory locks; all workers must use this implementation and
the same lock settings. The filesystem must support atomic mkdir/rename and
reliable modification times. Independent volumes cache independently. Downloads
are validated before publication and renamed atomically from a temporary file.
Locks heartbeat every 10 seconds and become stale after 120 seconds (crashed-worker
recovery); contenders retry for up to five minutes. Do not delete a live lock or
mix implementations with different lease settings. Suspend/stall durations above
the lease can compromise a lock; the worker fails that search rather than knowingly
publishing after losing ownership. Keep clocks synchronized across shared-volume
hosts. Cache directories are dedicated to generated files, not user documents.

Verification: `npx tsx --test scripts/supermarket-cache.test.ts` covers deterministic
clock/network fixtures and separate Node worker processes sharing a directory.
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
