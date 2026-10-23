# Backend architecture migration and API alignment

## Mission and intended outcome

Migrate the backend to NestJS with Express, organized into feature modules with
explicit contracts, application services, persistence, and transport adapters.
This is an architectural migration: move business operations out of HTTP
handlers so HTTP, synchronization, workers, and future MCP tools can invoke the
same authorized operation without constructing fake requests or replies.

The decision to use Express prioritizes integration and maintenance over the
additional HTTP throughput Fastify offers. Keep PostgreSQL/Drizzle, Supabase
authentication, BullMQ, and R2. Payments, coupons, and MCP are future consumers
of the boundaries established here; implementing them is outside this mission.

Primary tracker: [#178](https://github.com/Neuton-AI/Neuton-Back/issues/178).
The original API audit work is tracked in
[#172](https://github.com/Neuton-AI/Neuton-Back/issues/172). Its unfinished work
is preserved at the end of this document; completing the framework migration
does not automatically complete every remaining audit improvement.

## Execution rules and current position

- Work on `refactor/B/n178-nestjs-express`, based on merged #177 (`6e4b390`).
- Continue directly without agents, as honi requested on 2026-10-23. Earlier
  delegation instructions are historical and no longer govern execution.
- Follow the git, API/interface design, code-quality, monitoring, and incremental
  implementation skills. Implement one verifiable slice, review it, commit it,
  then proceed. Do not weaken assertions, skip failing tests, or broaden a slice
  to unrelated fixes to obtain a green checkpoint.
- At every completed phase or commit checkpoint announce:
  "honi, x was done, now starting with y".
- All five implementation phases are complete. Production startup now composes
  NestJS with Express. Fastify routes, plugins, interception, harnesses and direct
  dependencies are removed. Work was implemented directly without agents.
- Final verification passed 414/414 backend tests, zero skips, including all
  disposable PostgreSQL cases. Production/test typechecks, build and migration
  validation passed. Frontend verification passed 457/457 tests, lint, types and
  build for the unchanged companion upload branch. Self-review and draft PR
  preparation are complete: [backend #179](https://github.com/Neuton-AI/Neuton-Back/pull/179)
  and [frontend #171](https://github.com/Neuton-AI/Neuton-Front/pull/171).
  Merging/deployment remain separate.

## Decisions that are already settled

| Decision | Required behavior |
| --- | --- |
| Framework and transport (#178) | NestJS using Express; feature modules own contracts, services, persistence, and adapters. |
| Stock retries (#174) | Client idempotency keys are mandatory. Reject missing keys; no compatibility bypass. Replays must not apply stock twice. |
| Uploads (#175) | Use the grouped upload flow and remove the legacy flow, including obsolete client and worker branches. |
| Query naming (#176) | Query parameters use camelCase; remove old names rather than adding aliases. Coordinate actual callers. |
| Model output (#173, closed) | Preserve extract → enrich → unverified review → user correction/verification. User input takes precedence over extraction and enrichment. |
| Approval | An unverified receipt must not enter inventory. Preserve operation-specific verification; no new draft table or stricter model-content acceptance policy. |
| Response boundaries | Define explicit public DTOs and mappings. Preserve existing serialized fields, decimal strings, dates, envelopes, and statuses unless an intentional change is documented and tested. |

Do not reopen these decisions as unanswered architecture questions. In
particular, model variability alone is not a reason to reject drafts before
the user can review them. Technical provider/parsing failure handling remains
distinct from approving extracted business data.

## Target module boundaries

Each feature owns the smallest useful set of the following responsibilities:

- **Contracts:** externally validated inputs and explicit application outputs.
  Public outputs must not be aliases of Drizzle rows or spread arbitrary rows.
- **Application services:** business rules, role policy, lifecycle transitions,
  and orchestration. Accept verified `ActorContext` explicitly; service-level
  authorization protects callers outside HTTP too.
- **Persistence:** tenant-scoped Drizzle queries, locks, conditional updates,
  and explicit row mapping. Database models stay within this boundary.
- **Transport adapters:** Nest controllers validate input and invoke services;
  queue and sync adapters invoke the same operations. No service imports HTTP
  request/reply types or calls a controller to perform business work.

Use explicit Nest injection decorators, as this repository's tsx setup does not
depend on emitted decorator metadata. Reuse existing pricing, conversion,
receipt verification, and upload helpers instead of creating competing versions.
Avoid a generic event bus, repository framework, or second transaction framework.

### Transactions and side effects

The caller that owns an outer sync transaction also owns commit and rollback.
Bind feature services to its transaction explicitly; the orders precedent is
`inTransaction(tx, afterCommit)`. A nested transaction/savepoint is not an outer
commit. Business writes and durable replay receipts must succeed or fail together.

Audit and success logs may use deferred callbacks executed only after the
outer commit; discard them on rollback. Required external cleanup must be
durable: save deletion intent in the same transaction as document deletion,
then let a retrying dispatcher remove the R2 objects after commit. An in-memory
callback alone cannot survive a process crash.

Changing HTTP frameworks itself requires no schema migration. The separately
identified storage-cleanup defect does: an outbox records pending deletions.
Deliver any such schema change as a new migration, verify it on disposable
PostgreSQL, and document rollout independently of the framework cutover.

## Ordered implementation phases

### Phase 1 — HTTP foundation, identity, and orders (complete)

Established shared Nest/Express setup for security headers, CORS, explicit
proxy trust, rate limits, body limits/raw bytes, safe error responses, request
and trace correlation, and completion logging. Added tenant identity/actor
resolution and shared order services for quote, list/detail, create, verify,
and cancellation. Fastify orders now delegate to those services.

Verified tenant/role rejection, explicit response serialization, invoice
numbering, concurrent transitions, sync replay, and outer rollback. Fixed the
buffered Fastify reply thenable hang exposed by synced order creation.

Completed commits: `a00af9b` (HTTP foundation), `10cfbae` (identity), `bd3d349`
(orders), and `c0749bb` (legacy/sync integration). Latest full run passed
388/389 with zero skips; its sole failure was an incomplete old order fixture.
That fixture was corrected without changing production or weakening assertions,
and the affected HTML suite then passed 6/6. Typechecks, build, migration
validation, and database integration checks passed. This is not a claim that a
second full 389-test run was performed after the fixture-only correction.

### Phase 2 — Catalog, inventory, receipts, and uploads (complete)

Completed on 2026-10-23, implemented and reviewed directly without agents.
Catalog reads and writes, inventory mutations, manual/barcode pricing, recipe
verification/deletion, receipt review/verification/deletion, and grouped upload
transport now have shared services and Nest adapters. Production Fastify routes
are thin delegates to the same operations; the runtime cutover remains phase 5.
User corrections and the unverified review workflow are preserved.

Deletion now records deduplicated storage-cleanup intents in the domain
transaction. A leased dispatcher retries R2 deletion outside database locks,
recovers expired leases, and acknowledges only its own lease. Startup and
shutdown are wired. Receipt deletion refuses verified documents. Recipe deletion
uses a savepoint for the expected FK refusal and preserves sales history by
deactivating the recipe. Workers and deletion use document → upload lock order.

The old single-file upload HTTP/client path and ungrouped queue/worker execution
are removed. Grouped uploads preserve document IDs and safely redispatch on
completion retry. The frontend companion branch is
`refactor/F/n178-grouped-uploads`, commit `a56a51f`. Manual upload smoke tooling
now uses the authenticated grouped API; it was updated, not run against live
credentials.

Completion evidence: **406/406 backend tests passed, zero skips**, including
real disposable-PostgreSQL tenant boundaries, rollback/replay, worker/deletion
contention, savepoint fallback, leases, crash recovery and retry tests. Backend
test typecheck, production build and migration validation passed. Frontend
`npm run verify` passed: lint, typecheck, **457/457 tests**, and production build.
Reviewed correctness, authorization, explicit DTO mapping, transaction effects,
lock ordering, external-I/O placement, and safe correlated diagnostics.

Final implementation checkpoints: `4b05947` (durable cleanup), `966fdf4`
(inventory/pricing/deletion services), `64e910b` (upload module), `380b451`
(receipts and transport delegation), and `5733857` (grouped jobs/lock ordering).
Earlier catalog checkpoints remain in Git history and the migration notes.

**Deployment prerequisite:** apply `0030_storage_object_deletions.sql` before
running this backend version. It was applied only to the disposable test DB;
no developer or production database was migrated. Ship the grouped-only client
and backend together. Drain old ungrouped jobs before rollout; these jobs are
now rejected. Keep the cleanup table and pending intents if rolling back; do
not drop durable work. Watch `storage_cleanup_retry`,
`storage_cleanup_dispatch_failed`, and due/expired-lease backlog. This phase
has not been merged or deployed. Mandatory stock keys (#174) and camelCase-only
queries (#176) remain explicitly assigned to later phases.

The following completed slice descriptions retain the acceptance criteria:

1. **Catalog reads and shared costing.** Move categories, recipe list/detail,
   orderable recipes, and inventory reads into feature contracts, persistence,
   and services. Move `costRecipe` out of the route module and make legacy and
   Nest adapters call one implementation. Keep costing math and corrected
   ingredient names, links, quantities, and units intact. Define explicit DTOs,
   including nested sources and recipe steps. Register the static
   `/recipes/orderable` Nest route before `/:id`.
   Verification: HTTP/service authorization, foreign-tenant isolation, query
   defaults, decimal/date mapping, omission of unknown database fields, zero
   prices, unresolved costs, out-of-stock orderable recipes, and existing
   costing/editor/manual-product regressions. Preserve behavior in this
   extraction; the separately planned boolean-parsing fix is still pending.
2. **Catalog writes.** Move category, recipe, ingredient, inventory, manual
   product, barcode-price, stock adjustment, and verification operations into
   services, in small independently tested commits. Reuse owned-link validation
   and locking. Bind writes to caller transactions and remove their duplicate
   route implementations. Verification: role/tenant rejection before writes,
   rollback, reviewed ingredient preservation, pricing, and stock concurrency.
3. **Durable cleanup infrastructure.** Add deletion intent persistence and a
   bounded dispatcher. Claim due work with leases in a short database
   transaction; delete R2 objects outside the transaction; acknowledge only
   the matching lease. Retry failures with capped backoff and recover expired
   leases after a crash. Keep intent when documents/shops disappear. Verify
   rollback visibility, competing dispatchers, failed deletion, expired leases,
   and safe retry after deletion but before acknowledgement.
4. **Worker/deletion lock agreement.** Before enabling atomic document
   deletion, establish document-row → upload-row ordering in both paths.
   Read the upload association, lock its tenant-owned document, then lock and
   revalidate the upload. Keep worker business writes and `processedAt` atomic.
   Use deterministic concurrency tests, not timing sleeps.
5. **Receipt review and deletion.** Move list/detail/status/pending-count,
   verification, and deletion into feature services. Reuse `verifyReceipt` as
   the inventory implementation. Receipt deletion locks the document, rejects
   verified receipts, captures deduplicated primary/grouped paths, inserts
   cleanup intents, and deletes within the same caller transaction. Preserve
   unverified review and the user's corrections. Verify inventory is untouched
   before approval and that outer rollback restores documents with no cleanup.
6. **Recipe deletion.** Use the same durable cleanup infrastructure. Keep sales
   history: attempt hard deletion inside a savepoint and handle only the
   expected FK refusal by deactivating the recipe and removing upload/storage
   references. Verify the outer transaction remains usable after FK fallback,
   and that no objects are deleted for rolled-back operations.
7. **Upload transport.** Move presign, complete, and authorized download into
   feature-owned interfaces/adapters using the existing grouped helper. Preserve
   stable document identities, completion retry guarantees, renewal, source
   limits, and queue-after-commit behavior. Remove the old upload flow in its
   own coordinated #175 commit, including callers/types/jobs that still use it.

Phase exit: catalog and receipt operations are callable through Nest and shared
services; verification and cleanup preserve transaction guarantees; upload
retries and tenant checks pass; remaining Fastify adapters contain no duplicated
business implementation. Durable cleanup must have startup/shutdown wiring
before production deletion starts depending on it.

### Phase 3 — Session, profile, shops, and analytics (complete)

1. Move session/profile/password and shop create/read/update/delivery operations
   into their owning services and Nest adapters. Distinguish authenticated
   session access from operations requiring a selected shop; shop creation must
   not require membership in a shop that does not exist yet. Preserve roles,
   provider error behavior, and safe logging.
2. Move dashboard, recent-order, and inventory-value queries into analytics
   persistence/services with explicit output mapping. Preserve date boundaries,
   verified-receipt spend, and non-cancelled/non-deleted order calculations.
3. Implement the camelCase-only query change (#176), inspect real frontend
   callers, and update them in the same coordinated slice. Test rejection or
   removal of old input handling rather than silently retaining an alias.

Phase exit: every capability in the current shops and analytics routes has a
tested Nest equivalent; cross-tenant and unauthorized requests fail; serialized
responses and aggregates match their contracts.

### Phase 4 — Explicit sync orchestration and worker application services (complete)

1. Replace `onRoute` wrapping, request collaborator replacement, and buffered
   replies with explicit mutation orchestration calling domain services. Keep
   replay identity/signature checks, versions, tombstones, authorization,
   conflict results, domain writes, and durable retry receipts atomic.
2. Move worker business persistence into feature use cases. Keep BullMQ job
   startup, retry/deadline policy, circuit breaker behavior, and queue metadata
   in the worker adapter. Extraction and enrichment must preserve corrections
   and must not grant approval by saving model output.
3. Carry request/job trace and entry-point metadata through shared operations.
   Emit success after commit; classify failures without logging credentials,
   raw provider responses, personal data, or full request bodies.

Phase exit: sync/workers invoke services directly; no route handler is used as a
business API. Real database tests prove replay, payload mismatch, version
conflict, rollback, redelivery, and concurrent processing protections. A failed
sync receipt cannot leave a committed business operation or cleanup effect.

### Phase 5 — Contract changes, production cutover, and legacy removal (complete)

1. Make stock idempotency keys mandatory (#174), retaining atomic claim/replay
   and payload mismatch checks. Inspect clients before updating them; generate
   a stable key once per user intent, never anew for each retry. Test missing
   keys and unknown-outcome retries. Finish any remaining #175/#176 caller work.
2. Compose all Nest modules in the production root and switch API startup to
   Express. Preserve configuration validation, health behavior, signed raw-body
   support, trusted-proxy settings, and bounded graceful shutdown. Start and
   stop cleanup polling at process lifecycle boundaries, not module import.
3. Move remaining HTTP tests onto the production Nest configuration and remove
   Fastify routes/plugins/request augmentations/harnesses/dependencies when all
   callers have migrated. Search production and test code for obsolete imports
   and handler-interception mechanisms; do not leave an unused second stack.
4. Run complete verification, inspect the final diff for architecture/security/
   correctness/readability issues, document module conventions and rollout,
   and prepare a reviewable PR. Attach any created PR to this chat. Merge and
   production deployment are separate from implementing this migration.

Phase exit and mission completion: existing capabilities execute through
Nest/Express; services are the shared business boundary; no Fastify adapter or
dependency remains; decided contract changes are implemented; required checks
pass with database cases actually executed; documentation states remaining
limits and the rollback procedure.

## Verification and monitoring contract

Run focused tests after each slice and broader regression checks when shared
behavior changes. Use `npm run typecheck`, `npm run typecheck:test`,
`npm run build`, `npm run db:validate`, and the appropriate node:test suites.
There is currently no lint script; do not report a lint check as passed.

Run tests from `Temp` so root `.env` is not loaded, using:

```powershell
node ../node_modules/tsx/dist/cli.mjs --tsconfig ../tsconfig.test.json --test --test-force-exit --test-concurrency=1 ../scripts/*.test.ts
```

Database tests must opt in to an explicitly disposable local database through
their `*_TEST_DATABASE_URL` variables. Never apply fixtures or migrations to
the developer's configured database. Record executed and skipped test counts,
failures/fixes, and what was independently rerun. Use real PostgreSQL for lock,
constraint, concurrency, and transaction claims; scripted DB tests alone do not
prove those properties. Keep timeout bounds on tests that can deadlock.

Monitor questions: which request/job failed; where time was spent; whether the
transaction committed; whether database, auth, storage, or queue failed. Reuse
the structured logger with stable event names, request/trace IDs, and entry-point
fields. Route templates/status classes are bounded metric dimensions; raw
URLs, identifiers, tokens, and request payloads are not metric labels. Verify
induced failures produce safe, correlated diagnostics. Production dashboards
and alert delivery require the deployment environment and must not be claimed
as locally verified.

## Risks, rollback, and deferred audit work

- **Partial cutover:** keep the known production entry point until every
  feature is ready. A feature checkpoint is not a production cutover.
- **Transaction escape:** services must use the caller's transaction for all
  related writes; test injected failure at the durable replay receipt boundary.
- **Storage loss and deadlocks:** commit cleanup intent with deletion, retry it
  durably, and agree document/upload lock order before enabling the new path.
- **Response drift:** explicit DTOs need complete typed test rows and contract
  assertions. Do not weaken the mapper because an old fixture omitted fields.
- **Dependency findings:** existing Drizzle/Drizzle Kit findings were recorded
  at foundation review. Do not apply a blind breaking audit-fix downgrade or
  present pre-existing findings as introduced by Nest.
- **Rollback:** before cutover, retain the current startup. After cutover,
  redeploy the last tested artifact; coordinate client contract changes and
  cleanup-schema changes independently. Do not drop durable cleanup intent
  merely to roll back an HTTP framework deployment.
- **Deferred #172 work:** boolean query parsing, pagination/batched costing,
  complete sync traversal, broader mutation retry policy, public API
  documentation, and remaining error classification still need explicit slices
  and evidence. Migration alone does not mark them done. No optional key or
  legacy query alias proposal below overrides honi's settled decisions.

Operational details and historical checkpoints remain in
[docs/nestjs-migration.md](../docs/nestjs-migration.md). Update this mission plan
when scope, dependencies, or completion state changes so work can resume without
reconstructing the conversation.

---

# Historical API/interface alignment plan — #172

The following is retained as the original audit plan and progress record.
Its compatibility proposals are historical; the settled decisions above take
precedence. Its phase numbers refer to #172, not the five migration phases.

## Current continuation: NestJS migration (#178)

The approved migration extends this API alignment work. Execution phases and
verification are recorded in [the migration plan](../docs/nestjs-migration.md).
The original phase history below is retained. Later user decisions supersede
its compatibility assumptions: stock keys are mandatory (#174), legacy uploads
are removed (#175), query names use camelCase without aliases (#176), and the
existing extraction/review flow is sufficient with user input taking precedence
(#173, closed). These supersede the earlier optional-key and alias proposals.

Tasks tracked in [GitHub #172](https://github.com/Neuton-AI/Neuton-Back/issues/172). The audit report is the specification; preserve existing client wire contracts while fixing defects.

## Ordered phases

1. Correctness: atomic/replay-safe stock batches, atomic order transitions, validated model responses, and tenant-owned category/inventory links. Verify rollback, concurrent duplicates, payload mismatch, transition races, malformed model output, and two-tenant rejection.
2. Boundary/cleanup: explicit boolean query parsing and durable post-commit object deletion. Verify false/invalid query flags and outer transaction rollback.
3. Contracts: explicit service inputs/outputs and public response schemas, retaining serialized fields/types. Verify representative HTTP contracts and typechecks.
4. Collections: additive pagination and batched recipe costing; coordinated sync chunking without losing tombstones. Verify stable page boundaries and complete sync traversal.
5. Retry policy: document every mutation, fill non-idempotent create/legacy gaps, define in-flight waits and retention. Verify retry/unknown outcome behavior.
6. Error/docs: classify known conflicts, normalize correlation, generate API docs and compatibility checks. Verify stable error codes and contract diffs.
7. Naming: additive aliases and documented exceptions; no breaking enum/field renames. Verify old/new inputs and response compatibility.

Each phase depends on the previous phase. Within phase 1, each independent correctness fix is a separately tested slice. Run focused regression tests per slice and repository verification at checkpoints. Real database tests must use an explicitly configured disposable local database. Never migrate the developer's configured database.

## Decisions and risks

- Existing callers may omit retry identities. Keep old requests accepted but document unsafe retries; accept a durable client key for retry-safe stock changes.
- Retain retry receipts until the shop is deleted, matching the existing durable synchronization model.
- Tenant ownership checks belong in the shared write boundary, under locks so concurrent deletes cannot invalidate validation before the write.
- Keep this ticket's branch separate from the previously audited branch; base is local `origin/main`, matching the audited commit.
- Do not claim phase completion until its tests and verification pass. Database migrations are delivered as forward-only files; production application is outside this task.

## Progress

- [x] Ticket #172 created; branch `fix/B/n172-api-interface-alignment` opened.
- [x] Phase 1 — 371 tests passed, zero skips; typechecks/build/migration validation passed.
- [ ] Phase 2
- [ ] Phase 3
- [ ] Phase 4
- [ ] Phase 5
- [ ] Phase 6
- [ ] Phase 7
