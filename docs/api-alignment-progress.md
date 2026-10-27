# API alignment — issue #172

Branch: `fix/B/n172-api-interface-alignment`. Phases follow the audit's recommended order; task status is in `tasks/plan.md` and GitHub #172.

## Phase 1 contracts

Status: complete. Full suite: **371 passed, 0 failed, 0 skipped**. Phases 2–7 remain pending.

- `POST /api/v1/inventory/adjust` applies the whole batch in one transaction. Duplicate item IDs are invalid (400); any unavailable/foreign item rejects the entire batch (403).
- `POST /api/v1/inventory/adjust` requires a UUID `Idempotency-Key` (#174). Missing or invalid keys are rejected before any database work. Generate one key per intent and reuse it unchanged when the outcome is unknown. A same-shop/same-user/same-payload retry returns the saved `{ adjusted, ids }`; a changed payload or user is 409. An in-flight duplicate whose claim has no saved response is also 409 (`Stock adjustment is still pending`). Payload ordering is significant. Claims are unique on `(shop_id, id)` and commit with stock writes and the response. Failed transactions leave no claim or effects. Receipts remain until shop deletion. There is no current frontend caller; a future client must persist that key across retries and reload.
- Existing order verification keeps its sequential 400/404 behavior. If an order changes between reading and writing, verification returns 409 and cannot revive cancelled/deleted orders or repeat a delivery transition.
- Model JSON crosses a local structural/normalization boundary inside each model attempt. Invalid extraction structures trigger fallback. Receipt derived prices are finite or null; unknown base units become null.
- Category/inventory references must belong to the active shop on recipe create/update/verify and inventory create/update. Validation runs inside the write transaction, before changes, and locks referenced rows until commit.

Deployment: apply `drizzle/0029_inventory_adjustment_batches.sql` before enabling keyed stock adjustments. No production migration was applied during implementation. Follow-ups #174, #175, and #176 are implemented on `main`: stock keys are mandatory, uploads are grouped-only, and API query parameters are camelCase. Rollout notes are in `docs/nestjs-migration.md`.

## Verification

Real PostgreSQL tests require explicit disposable database URLs; never point them at shared application data.

Phase 1 regression evidence:

- Model boundary tests: 16 failures reproduced before the fix; malformed responses now advance to the next model and normalized derived prices remain finite or null.
- Order race: a real PostgreSQL test paused verification after its read, committed cancellation, then resumed verification. Before the fix it returned 200 and overwrote cancellation; after the fix it returns 409 and preserves cancellation. Competing delivery and soft deletion are covered too.
- Stock: real concurrent same-key requests apply one delta, payload/user mismatch returns 409, another shop has an independent key namespace, and a failed second update rolls back both the first update and retry receipt.
- Ownership: all five create/update/verify paths reject foreign links before writes; an owned link succeeds. Historical foreign inventory links are also excluded from costing joins.
- An existing receipt-inventory integration fixture failed on a fully migrated database because it lacked an auth user and scanned-document path. The fixture now satisfies those constraints without weakening assertions; concurrent SMA/quantity checks pass.
- All migration SQL parses, and migrations through 0029 apply successfully to a newly created local PostgreSQL 18 database with minimal Supabase auth objects.

For the full suite, all disposable-database opt-in variables were set to the local test database. Tests run serially because some existing files use fixed fixture IDs. `--test-force-exit` closes test processes after test completion instead of waiting for the PostgreSQL client's idle timers. The signed-download fixture is seeded so that test executes instead of returning early.

Repository checks: `npm run typecheck`, `npm run typecheck:test`, `npm run build`, `npm run db:validate`, and `git diff --check`.
