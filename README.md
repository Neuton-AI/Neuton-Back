# Neuton-Back

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
