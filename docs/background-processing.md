# Background processing and synchronization authorization

Phase E implements Tasks 49–55. Migration `0013_processing_authorization.sql`
adds the resource revision baseline and tightens the existing worker routines,
row policies and column grants. Apply it before starting the updated API and
worker. Applied migration files remain immutable; subsequent SQL changes use a
new migration.

## Durable submission and publication

Upload completion checks object metadata outside SQL, then reestablishes the
current session, shop membership, required role and live resource association.
Readiness and `app_private.register_job` commit together. Registration derives the
requester from verified context and the operation, resource and source digest
from the persisted upload. It assigns `upload-<upload UUID>` and a one-day expiry.
A retry preserves the original requester, source digest, expiry and state.
Failed registration rolls back readiness. Failed publication leaves accepted work
in PostgreSQL; completion can retry the same identity. Terminal or expired jobs
cannot be resubmitted through completion; a new upload is required.

Redis receives only `{ jobId }`. The worker never trusts queue shop, user, kind,
source or resource fields. Its publication dispatcher also recovers accepted jobs
on startup and every five seconds. It resolves authorized inputs in a short worker
transaction, releases SQL before publication, and records the queued transition
through a restricted routine. Stable BullMQ IDs prevent duplicate publication.
Publishers have bounded Redis connection/retry behavior; workers retain the
blocking/reconnection settings BullMQ requires. Both close their owned clients.

## Worker stages

The worker uses `WORKER_DATABASE_URL` through `createWorkerDatabase`; it does not
initialize an app, auth or owner pool or require SMTP/Google credentials. Shared
Redis, storage, AI and logging settings still apply.

`withJobTransaction` resolves the persisted authorization and current active
account, administrative membership, expiry, allowed operation and immutable source
association. It holds shared account/shop locks and locks document, upload and
job state in that order. No session is required: logout alone leaves accepted
work valid. Disablement, membership loss, expiry, cancellation, deletion and
incompatible document state prevent protected work.

The persisted resource revision detects edits after acceptance or between stages.
A restricted routine checks and locks version metadata without giving the worker
direct version-table mutation rights. Successful active stages advance their own
baseline in the same transaction; a human edit cancels the stale job.

Storage reads, Gemini calls, product searches and preview generation run between
short transactions. Each later stage resolves current authority again. The final
transaction commits extracted rows, linked costs, preview metadata, the processed
marker, audit and job outcome together. Domain/version triggers remain atomic.
Recipe/product processing updates the existing placeholder and cannot insert a
replacement parent. Product documents retain the existing recipe extraction
pipeline. Worker reads are operation-specific, writes are restricted to the
job's exact resource, and column grants exclude attribution, verification,
delivery and lifecycle fields. Global prices use the existing narrow routine.

Circuit breakers, two-attempt queue retries, source limits and processing deadlines
remain in force. External waits have a deadline; SQL is not retained while they
run. Terminal failure callbacks use a fresh job scope and cannot overwrite a
completed, cancelled, deleted, edited or unauthorized document. Post-commit logging
or progress failures do not turn a committed document into a failed database job.

## Storage cleanup

The API explicitly owns a separate `CLEANUP_DATABASE_URL` pool and starts/stops the
cleanup dispatcher. Claims, acknowledgements and retries use only
`claim_storage_deletions`, `complete_storage_deletion` and
`retry_storage_deletion`. Cleanup has no direct table scan or auth-table access.

SQL claims bounded leased batches and releases locks before object storage I/O.
Acknowledgements match the lease token; failed operations retain durable retry
intent. Expired leases and storage deletion followed by a lost acknowledgement
can be retried. Cleanup remains usable after document/shop deletion and membership
loss. Shutdown aborts active storage requests, waits for the dispatcher and closes
its own pool.

## Backend synchronization

Comparison reads, tombstones, versions and snapshot payloads use verified selected
shop transactions. A snapshot checks its revision around a payload read using the
same capability and retries a changing document within the existing bounded
budget. User-only context cannot read operational rows.

Mutation receipts remain bound to original shop, user and request identity.
Reconciliation preserves base-version and idempotency behavior. A conflicting
receipt belonging to another user returns no cached response; an insert collision
rolls back the resource change, audit and version effects together.

`DATABASE_LISTEN_URL` is mandatory and direct/session-based; it has no URL fallback.
The dedicated listener executes notification commands only and forwards shop
wake-up hints. Tenant reads use the normal selected-shop connection.

Event streams hold no SQL transaction. They reauthorize the original session,
user and selected membership before every hint and every fifteen seconds while
quiet. Heartbeats do not renew session activity. Revocation, expiry, disablement,
membership loss, a changed identity or an unavailable authorization dependency
closes the stream; authorization waits also have a bounded watchdog.

Frontend consumers use cookie auth and environment/user/shop offline partitions.
The external-auth runtime is retired. Production cutover remains a separately
authorized operation; see [setup and operations](auth-setup.md).
