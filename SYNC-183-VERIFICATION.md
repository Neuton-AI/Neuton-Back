# #183 local verification

Date: 2026-10-29. Branch in both repositories: `feature/183-native-document-sync`.

## Environment

Disposable PostgreSQL 18 cluster on localhost:55432, with the repository migrations
through 0031 applied. Minimal local auth-schema fixtures support existing migrations;
no Supabase Realtime service, publication, replication slot or extension is involved.
The existing hosted database was not migrated or used for browser mutations.

## Automated checks

- Frontend: `npm run verify` (lint, TypeScript, Vitest and production build).
- Backend: `npm run verify`, with DATABASE_URL, SYNC_TEST_DATABASE_URL and
  NATIVE_SYNC_TEST_DATABASE_URL set to the disposable migrated database.
- SQL syntax: `npm run db:validate`.
- Final results: frontend 543 tests passed across 64 files, with lint, types and
  production build passing. Backend 418 tests passed, zero failed, 12 existing
  optional integration tests skipped; application/test types and build passed.
- Native integration: commit-only delivery, rollback, independent listener fan-out,
  connection termination and listener recovery.
- HTTP SSE: shop authorization, delivery, membership revocation and source loss.
- Revision integration: stale edits with larger client timestamps are refused;
  committed mutation replay remains idempotent.
- Snapshot tests: overlapping commits trigger rereads; payloads carry the stable
  revision, and continuously changing documents produce a retryable response.
- Client: SSE framing/reconnect/disposal, event-during-run burst handling, retry,
  field/identified-row merges, durable conflict resolution, remote deletion,
  preservation of incoming untouched fields and a 20,001-document comparison.
- Existing offline/upload tests remain enabled. Processing query tests now assert
  invalidation-driven updates and absence of periodic polling.

The old document-sync integration test failed at line 299 on unchanged main as
well: deletion schedules both source and deterministic preview cleanup paths.
Its assertion now verifies both exact paths and that replay creates no extras.

## Chrome DevTools MCP browser verification

Used two isolated Chrome browser contexts with separate IndexedDB storage and the
actual React application, sync engine and Nest endpoints. Authentication alone
used a known disposable fixture session; database listeners and sync were real.

1. Saving a recipe name and ingredient in A updated the idle catalog in B.
2. A direct database update changed name and preparation time. B updated both.
   A retained its unsaved name, adopted the untouched preparation time, and showed
   inline name-conflict choices. The recipe editor regression test covers choosing
   the incoming value; durable queue tests cover local and server choices.
3. Updating processing status changed B's card to Reading without navigation.
4. Deleting the fixture recipe removed B's card automatically.
5. Terminating the native listener and inserting a new recipe during the gap caused
   B to discover it on reconnect through version comparison, without replay history.
6. An idle browser's completed /sync/check count stayed at four across two observations
   separated by other tests; heartbeats did not trigger periodic comparisons.

Fixtures showed existing React Router/deprecated-meta warnings and telemetry errors
because the isolated fixture did not provide a collector. No sync-related application
exception was observed after the fixture CORS setup was corrected.

## Deployment limits

This verifies local functional behavior, not production throughput or a measured
p95 commit-to-visible latency. The roughly 1–2 second target still needs a staging
measurement with the deployed proxy, direct/session-pooled listener URL, auth service
and representative shop sizes. Review README streaming/rollback setup before rollout.
No production migration or deployment was performed.
