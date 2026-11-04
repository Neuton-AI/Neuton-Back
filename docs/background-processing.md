# Background processing migration

## Durable submission

Upload completion verifies source metadata outside SQL, then reestablishes the
current session, shop membership, required role and live resource association.
Inside that shop transaction it locks the document before the upload, records
readiness and calls `app_private.register_job`. Registration derives the job's
requester from the verified transaction context and its operation, resource and
source digest from the persisted upload. The existing database routine assigns
the fixed `upload-<upload UUID>` identity and a one-day expiry.

The transaction commits before Redis publication. Failed registration rolls back
readiness. Failed publication leaves accepted authorization in PostgreSQL; calling
completion again publishes the same job. Registration conflicts preserve the
original requester, source digest, expiry and processing state. A retry does not
extend the authorization lifetime. Correlation comes from the current server actor
and is bounded to 128 characters.

Queue submission now includes the persisted `jobId` and rejects a job ID that does
not match its upload. The other queue fields remain during the worker migration.

## Remaining Phase E work

This submission increment does not finish the worker migration. Task 50 must make
workers resolve authority through the persisted job ID and use the worker pool;
Tasks 51–52 must split processing into short authorized stages around external
calls and reauthorize terminal effects. Workers must then ignore queue identity
and source fields as authority. Autonomous republication of accepted jobs can use
the same fixed identity; the current recovery entry point is completion retry.

Tasks 53–55 cover the restricted cleanup connection, scoped synchronization reads
and live-stream reauthorization. These are separate increments in Phase E.
