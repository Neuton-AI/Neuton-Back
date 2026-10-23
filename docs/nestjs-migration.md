# NestJS / Express migration — #178

Tracking: https://github.com/Neuton-AI/Neuton-Back/issues/178

## Completion status — 2026-10-23

All five implementation phases are complete. `src/app.ts` now composes the
production Nest/Express application; `src/index.ts` owns API and cleanup
lifecycle. Fastify routes, plugins, reply interception, logger adapters, test
harnesses and direct dependencies are removed. Historical checkpoint notes
below describe the transition and are superseded by this completion record.

Final backend regression run: **414/414 passed, zero skips**, with disposable
PostgreSQL cases enabled. Production typecheck, test typecheck, build and
migration validation passed. `npm ls` confirms no Fastify stack is installed.
Frontend verification for the companion upload commit passed lint, types,
**457/457 tests** and build. No tests were skipped to make this migration pass.

Phase 3 checkpoint: `dcbafc4`. Phase 4 checkpoint: `da35772`. Phase 5 replaces
the runtime and carries the final mandatory-stock-key decision. Missing or
invalid keys fail before DB work, including direct application calls; concurrent
replays and payload/user mismatches retain the durable transaction guarantees.
There is no current frontend caller of `/inventory/adjust`; future clients must
persist one UUID per intent and reuse it for retries.

Queries use camelCase only. `distanceKm` replaces `distance_km`, unknown query
aliases are rejected, and `false` is parsed as false for catalog flags. Existing
frontend query callers already use camelCase. Nest exposes explicit shop,
profile, order, catalog, receipt, upload and analytics responses.

Review retained member permission to verify orders, safe provider failure
responses, and operation-specific authorization on sync replays. Late document
extraction cannot overwrite delivered/cancelled order snapshots. Onboarding
rolls profile, shop and ownership back together. Shop rename collision checks
exclude only the renamed shop, rather than filtering out other shops.
Regression tests cover each fix. Deliberately inverting the late-order guard
exposed a weak fixture; adding usable pricing data made the test detect the
mutation, and restored production source passed. The final full run follows
those fixes. Worker success logs wait for the durable processed marker's commit.

### Module conventions

Contracts validate external input and explicitly describe public output. A
controller resolves session/tenant context and calls a service; services own
authorization and operations, while persistence owns Drizzle access and mapping.
Use `inTransaction(tx, afterCommit)` when sync owns the outer transaction.
Required external deletion uses durable cleanup intents; callbacks are for
best-effort post-commit diagnostics/audit. The sync orchestrator invokes service
callbacks directly and records the retry receipt in their transaction. Workers
use the document-processing service with a queue-independent progress port;
BullMQ startup/retry/circuit policy remains in the worker adapter.

### Final rollout and rollback

1. Apply pending migrations through `0030_storage_object_deletions.sql` before
   this API version. Framework replacement itself needs no schema change. Only
   disposable test databases were migrated during this implementation.
2. Roll out the grouped-only backend and companion frontend together. Drain old
   ungrouped jobs first. The companion is
   [frontend PR #171](https://github.com/Neuton-AI/Neuton-Front/pull/171).
3. Set `TRUST_PROXY` to the actual proxy address/subnet list; blank trusts none.
   Keep rate-limit configuration valid, including positive `RATE_LIMIT_WINDOW`
   durations. The shared HTTP setup retains raw bytes for signed webhooks.
4. Check request/trace correlation, error status/latency, auth failures, queue
   redelivery and storage cleanup backlog. Observe `storage_cleanup_retry`,
   `storage_cleanup_dispatch_failed`, `http_request_failed` and safe post-commit
   diagnostics. Dashboard/alert delivery requires the deployment environment
   and has not been claimed as locally verified.
5. Roll back using a tested compatible API/client artifact pair. Preserve the
   cleanup table and pending/leased intents; never discard durable deletion
   work. Restart a compatible dispatcher so expired leases can recover.

No merge, production migration or deployment was performed. Payments, coupons,
MCP functionality and unrelated unfinished #172 audit items remain out of scope.

## Contract and boundaries

Use NestJS with Express and feature-owned contracts, application services,
persistence, and transport adapters. HTTP controllers validate external inputs,
resolve authenticated tenant context, and invoke services. Services own business
operations; persistence owns Drizzle queries. Workers and sync invoke services,
never HTTP handlers. Keep PostgreSQL, Drizzle, BullMQ, Supabase auth and R2.

Preserve current wire responses through explicit mappers. Intentional changes
from #174 (mandatory stock keys), #175 (grouped uploads only), and #176 (camelCase
queries) require coordinated client changes. #173 is closed: preserve extraction,
enrichment, unverified review, and user corrections; user input takes precedence.
Payments, coupons and MCP functionality are outside this migration.

## Ordered implementation checkpoints

1. HTTP foundation and orders: Nest/Express startup, correlation, errors, security,
   raw-body support, authentication/tenant guards, order contracts and services.
   Verify HTTP outcomes, authorization, create/verify/cancel and transaction races.
2. Catalog and receipts: feature services and persistence, explicit output mapping,
   human verification and uploads. Verify tenant boundaries, inventory effects,
   user corrections, rollback and upload redelivery.
3. Shops and analytics: move remaining HTTP capabilities and tests to Nest.
   Verify role checks, aggregate responses and consumer contracts.
4. Sync and workers: explicit service calls and transaction context replace route
   wrapping and reply interception. Verify replay, conflicts, rollback, job
   correlation and post-commit side effects.
5. Cutover and removal: production entry points use Nest, remove Fastify and its
   adapters after every consumer migrates. Run full regression suite, database
   integration cases, typechecks, build and migration validation; review diff.

Each phase is split into independently tested commits. Existing production
bootstrap remains active until replacement capabilities pass their checkpoints.
Do not merge or deploy a partial migration as the production replacement.

## Operational questions

- Which request or job failed, and can it be followed by request/trace ID?
- Which route is returning errors, and what is its latency distribution?
- Did a failure happen before or after the business transaction committed?
- Are failures in auth, storage, database or queue processing?

Use the existing structured logger and transport configuration. Stable event
names, entry-point fields and correlation IDs belong in logs. Route templates
and status classes are bounded metric dimensions; raw URLs, user identifiers,
tokens and request bodies must not become metric labels or request log payloads.
Verify successful and induced-failure telemetry in local HTTP tests. Production
dashboard and alert delivery verification requires the deployment environment.

## Verification and rollback

Use node:test/tsx and existing scripted collaborators for focused tests, and a
disposable local PostgreSQL instance for concurrency and transaction assertions.
Run tests from an isolated working directory so the developer .env is not loaded.
Commands: npm run typecheck; npm run typecheck:test; npm run build;
npm run db:validate; node ../node_modules/tsx/dist/cli.mjs --tsconfig ../tsconfig.test.json --test
--test-force-exit --test-concurrency=1 ../scripts/*.test.ts (from Temp).

Express proxy trust accepts an explicit list of deployment proxy addresses or
subnets; direct deployments trust none. Configure this at production cutover
and verify distinct forwarded clients receive independent rate-limit buckets.
The dependency audit at the foundation checkpoint reports existing Drizzle ORM
and Drizzle Kit/esbuild findings, with none in the newly added Nest/Express stack.
Do not apply the audit's suggested breaking downgrade of Drizzle Kit blindly.

No production schema migration is required for switching HTTP frameworks.
Before cutover, rollback is retaining the current production entry point. After
cutover, redeploy the prior tested artifact; coordinate any separate client
contract changes before doing so. Keep schema changes independently reversible.

## Framework sources

- https://docs.nestjs.com/first-steps
- https://docs.nestjs.com/modules
- https://docs.nestjs.com/guards
- https://docs.nestjs.com/exception-filters
- https://docs.nestjs.com/faq/raw-body

## Progress

### Execution ownership

The mission and detailed phase criteria are maintained in
[tasks/plan.md](../tasks/plan.md). From 2026-10-23 onward, honi requested direct
implementation without agents. Earlier delegation below records how the
foundation was delivered; it does not authorize further agent work.

- Identity slice: feature contracts, Supabase authentication, mandatory tenant
  membership resolution, Nest guards and actor decorator. Tests cover rejected
  and valid authentication/tenant paths; no credentials in logs.
- Orders slice (depends on identity contracts): Zod input contracts, explicit
  response mapping, Drizzle persistence, application services, Nest controller.
  Preserve numbering transactions, tenant isolation, lifecycle races and role
  rules. Verify new HTTP tests plus real database races before legacy delegation.
- Integration checkpoint: switch legacy order handlers to those same services
  while the production runtime remains Fastify; preserve sync transaction seams
  until the sync phase replaces handler wrapping. Review and commit only after
  focused regressions and type/build checks pass.

The primary assistant now owns implementation, review, verification, commits,
and phase-completion announcements.

### Remaining slice dependencies

Before catalog/receipt deletion migrates, implement a deletion-specific durable
storage cleanup outbox. Domain deletion and cleanup intent share the caller's
transaction; an independently retryable dispatcher deletes R2 objects after
commit. Do not substitute an in-memory callback for durable cleanup.

Use the existing actor contract and explicit transaction-bound services. Orders
supports `inTransaction(tx, afterCommit)`; callbacks are limited to best-effort
audit/logging, while required external effects use durable intents. Avoid a
second generic actor/transaction framework beside these contracts.

Phase 2 slices: catalog reads/costing, catalog writes, receipt review/deletion,
grouped upload transport. Phase 3 slices: session/profile/shop operations, then
analytics. Phase 4 slices: explicit sync mutation orchestration, then shared
worker use cases. Phase 5: coordinated client changes, runtime composition,
legacy removal and complete verification. Worker/deletion lock order must agree
before enabling the new deletion flow (document row before upload row).

The production cutover must honor mandatory stock keys, grouped-only uploads,
and camelCase-only query names, with client changes where callers exist. Keep
these intentional behavior changes in distinct tested commits.

- Branch: refactor/B/n178-nestjs-express, based on merged #177 (6e4b390).
- Phase 1 complete; phase 2 starts with catalog reads/costing and durable cleanup.
- HTTP foundation checkpoint: full regression baseline 373/373 passed with no
  skips against disposable PostgreSQL; four focused HTTP tests passed after
  review fixes; test typecheck and production build passed. Removing proxy trust
  makes the client-isolation regression fail (source restored). Independent
  review found no remaining blockers in this slice. Production still uses Fastify.

- Identity checkpoint (`10cfbae`): explicit actor contracts, tenant membership
  resolution, Nest guard and service role policy. Independent review approved;
  isolated identity tests passed, including malformed tenant input and safe logs.
- Orders checkpoint (`bd3d349`): explicit DTOs, shared pricing/lifecycle service,
  scoped persistence and Nest controller. Focused endpoint and real PostgreSQL
  tests passed, including competing verification/cancellation/deletion and outer
  rollback with no audit or success log. Test typecheck and build passed.
- Legacy order delegation is complete, removing duplicate business logic to
  defer sync success effects until the retry receipt and business write commit.

- Phase 1 integration review approved. Full regression run: 388/389 passed, zero
  skips; the sole failure was an incomplete legacy order fixture. Corrected that
  fixture with a typed complete row; affected HTML tests then passed 6/6.
  Production typecheck/build, test typecheck and migration validation passed.
  Real sync create/verify/cancel rollback and replay checks passed; suppressing
  post-commit effects makes the audit regression fail (source restored).
  Fixed a buffered Fastify reply thenable hang exposed by synced creation.

- Phase 2 catalog read checkpoint: extracted shared costing and tenant-scoped
  read services for categories, inventory, recipe list/detail, and orderable
  recipes. Both transports use explicit DTOs, including nested steps/sources.
  Preserved draft review, corrected ingredients, decimal/date representations,
  low-stock thresholds, and complete-cost out-of-stock orderable results.
  Full regression suite passed 394/394 with zero skips against disposable
  PostgreSQL; test typecheck/build passed. Mutation of the category shop filter
  is detected by the real database test and restored. Catalog writes, receipts,
  uploads, cleanup and later phases remain pending.

- Phase 2 initial write checkpoints: category and recipe creation use shared
  services and explicit outputs. Recipe creation retains pending status and
  supplied ingredient data; role/tenant validation precedes writes. Catalog
  transaction binding defers success diagnostics and recipe audit until outer
  commit. Latest focused regressions passed 19/19 with zero skips, including
  disposable PostgreSQL rollback/commit checks; test typecheck/build passed.
  This focused run followed the 394-test read checkpoint.

- Subsequent catalog write checkpoint: recipe editing and verification now
  delegate to transaction-bound services. Metadata-only edits retain ingredients;
  edited quantities use existing conversion rules, and verification preserves
  supplied corrections. Sync defers catalog success effects until outer commit.
  Real sync failures restore recipe metadata, approval status, and ingredient
  rows without premature audits. Shared ingredient mapping avoids three
  competing write formats. Full regression suite passed 398/398, zero skips,
  against disposable PostgreSQL; test typecheck/build passed. Review and
  implementation were performed directly without agents. Inventory writes,
  manual/barcode pricing, deletion, receipts, uploads and cleanup remain pending.

## Phase 2 completion — 2026-10-23

Phase 2 is complete. Catalog/inventory pricing and mutations, recipe deletion,
receipt review/verification/deletion and grouped uploads share application
services with explicit DTOs and Nest/legacy transport adapters. The worker now
locks the document before the upload and rejects ungrouped jobs; transaction
rollback and queue redelivery retain their guarantees. User review and corrected
values remain authoritative. Production still starts with Fastify until phase 5.

The deletion outbox is durable, leased and retryable. Receipt deletion refuses
verified documents; recipe FK fallback uses a savepoint and retains sales
history. Domain deletion and cleanup intent commit together, while R2 I/O runs
outside the domain transaction. Dispatcher startup/shutdown is wired.

Final backend verification: 406/406 tests passed, zero skips, using disposable
PostgreSQL for transaction/concurrency checks; test typecheck, production build
and migration validation passed. Frontend lint, typecheck, 457/457 tests and
production build passed. Review was performed directly without agents.

Backend checkpoints: `4b05947`, `966fdf4`, `64e910b`, `380b451`, `5733857`.
Frontend: `refactor/F/n178-grouped-uploads`, `a56a51f` removes the obsolete
single-file helper, its unused types and old-only tests; grouped tests remain.
The manual live-upload script now uses authenticated grouped API calls and
completion replay. It was not executed against live services.

### Rollout for the separate cleanup change

1. Apply `0030_storage_object_deletions.sql` before deploying this backend.
   Only disposable test databases have been migrated during implementation.
2. Coordinate frontend/backend rollout for grouped-only uploads. Drain old
   ungrouped jobs first; the worker now rejects them explicitly.
3. Observe `storage_cleanup_deleted`, `storage_cleanup_retry` and
   `storage_cleanup_dispatch_failed`; investigate growing due work and expired
   leases. Logs correlate shop, request, trace and attempt without file contents.
4. For rollback, retain the cleanup table and pending rows. A later compatible
   dispatcher can recover leased work after expiry; do not erase pending intents.
   Redeploy a compatible frontend/backend pair when rolling back the upload API.

No merge or deployment was performed. Next is phase 3: session/profile/shop
operations and analytics, including the planned camelCase query contract work.
Phase 4 owns the broader worker/sync service extraction; phase 5 owns mandatory
stock keys, full runtime composition and Fastify removal. The old pending-slice
statements above are historical checkpoint evidence, superseded by this record.

Phase 3 checkpoint (2026-10-23): session/profile/password, shop settings/onboarding
and delivery, plus dashboard/recent orders/inventory value, now use feature
services/persistence and Nest adapters. Session-only operations do not require
shop membership. Public profile/shop/order fields are explicitly mapped.
Queries are camelCase-only; old delivery distance input and unknown catalog
aliases are rejected. Boolean query values parse false correctly. Frontend
callers already use camelCase; no caller changes were necessary. Password
changes verify that the reauthenticated identity matches the acting user and
return a safe provider-failure message. Focused regressions passed 51/51; test
typecheck and build passed. Continuing directly into phase 4.

Phase 4 checkpoint (2026-10-23): Nest mutations now call explicit SyncService
orchestration, with transaction-bound domain services, signature/user replay
checks, document locks/version checks and durable receipts. No Nest handler is
called as a business API. Processing uses a queue-independent progress port,
a document-processing application service, and a persistence boundary. The
worker adapter retains queue lifecycle, retry/deadline and circuit-breaker
policy. Processing success logs wait for the processed marker's outer commit;
provider messages and extracted names are excluded from new diagnostics.
Focused suite: 90 ordinary tests passed; the two DB cases initially failed
because the disposable PostgreSQL was stopped, then both passed after restart.
An additional induced processed-marker failure test passed, proving success is
not emitted on rollback. Test typecheck and production build passed. Phase 5
will remove the still-present legacy runtime/adapters and migrate old harnesses.
