# Document synchronization (#161)

Apply migration `0028_document_sync.sql` before deploying the companion frontend.
This adds `document_versions` and `document_mutations`. Both tables enable RLS
without granting direct authenticated-client access; the API's database
connection owns synchronization. Existing domain tables and business validation
remain authoritative.

`POST /api/v1/sync/check` requires authentication and resolved shop membership.
It accepts `{ documents: [{ kind, id, updatedAt, deleted? }] }` and returns
`{ toPush, toPull }`. Kinds are receipt, recipe (including products) and order.
Timestamps are integer milliseconds. Equal versions transfer nothing. Missing
records and retained deletion tombstones remove stale local copies rather than
resurrecting hard-deleted receipts or inactive recipes. Order cancellation uses
the existing soft-delete contract. Document triggers also track worker and
ordinary online writes, including orders which have no `updatedAt` column.
Ingredient, inventory, linked-price and shop pricing changes also advance affected
recipe versions so persisted costing snapshots refresh. Ingredient writes within
one synchronized recipe edit retain its single client revision.

Existing recipe PATCH, document verify/delete and order create endpoints accept
optional `x-sync-id` (UUID) and `x-sync-version` (integer milliseconds). Their
original guards run first. Sync mutations acquire a shop advisory transaction
lock and document row lock, compare versions, then reuse the domain handler with
the transaction-bound database. The business change and its retry response
commit together. Reusing an ID with a different user/request is a conflict;
replaying an identical request returns its recorded result. An obsolete version
returns `{ syncConflict: true }` and the client compares/pulls again. Calls without
the headers keep their existing contracts. Version tombstones live until the
shop is deleted; cascading shop deletion does not recreate tombstones.

Grouped scan upload IDs already provide stable create and completion identities.
New receipt/recipe rows now use that same ID, so an offline placeholder and a
partially uploaded server document cannot appear as two different documents.
Previously created uploads keep the identities stored in their upload record.
The frontend persists these IDs with Blobs; this change does not introduce a
second upload API or bypass storage-size, authorization or processing checks.

## Tests

Run `npm run verify` and `npm run db:validate`. Metadata comparison unit tests run
without services. To exercise actual routes, rollback, retry receipts, conflicts,
tenant rejection and deletion triggers, point `SYNC_TEST_DATABASE_URL` at an
already migrated **disposable database** and run:

```powershell
node --import tsx --test scripts/document-sync.integration.test.ts
```

The integration suite opts out unless that explicit variable is set. It creates
and cleans up its own shop/account fixtures. The existing database-backed test
files share fixed fixture IDs, so run the full suite with `--test-concurrency=1`
when using one disposable database for every file.
