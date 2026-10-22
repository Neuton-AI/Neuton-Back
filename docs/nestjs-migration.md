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

- Branch: refactor/B/n178-nestjs-express, based on merged #177 (6e4b390).
- Phase 1 in progress; subsequent phases pending.
- HTTP foundation checkpoint: full regression baseline 373/373 passed with no
  skips against disposable PostgreSQL; four focused HTTP tests passed after
  review fixes; test typecheck and production build passed. Removing proxy trust
  makes the client-isolation regression fail (source restored). Independent
  review found no remaining blockers in this slice. Production still uses Fastify.
