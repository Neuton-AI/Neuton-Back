# NestJS / Express migration — #178

Tracking: https://github.com/Neuton-AI/Neuton-Back/issues/178

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

### Delegated execution

The orchestrator plans, integrates, verifies and commits each checkpoint. All
implementation and side-review agents use GPT-6.1 Sol at medium effort.

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

Agents have disjoint file ownership. Review agents are read-only; the
orchestrator owns commits and phase-completion announcements.

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
