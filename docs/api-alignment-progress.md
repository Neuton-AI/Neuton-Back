# API alignment — issue #172

Branch: `fix/B/n172-api-interface-alignment`. Phases follow the audit's recommended order; task status is in `tasks/plan.md` and GitHub #172.

## Phase 1 contracts

- `POST /api/v1/inventory/adjust` applies the whole batch in one transaction. Duplicate item IDs are invalid (400); any unavailable/foreign item rejects the entire batch (403).
- Supply a UUID `Idempotency-Key` generated once per user intent. Reuse it unchanged when the outcome is unknown. A same-shop/same-user/same-payload retry returns the saved `{ adjusted, ids }`; a changed payload/user is 409. Payload ordering is significant. Claims are unique on `(shop_id, id)` and commit with stock writes and the response. Failed transactions leave no claim/effects. Receipts remain until shop deletion. Without a key the batch remains atomic but is unsafe to retry after an unknown result.
- Existing order verification keeps its sequential 400/404 behavior. If an order changes between reading and writing, verification returns 409 and cannot revive cancelled/deleted orders or repeat a delivery transition.
- Model JSON crosses a local structural/normalization boundary inside each model attempt. Invalid extraction structures trigger fallback. Receipt derived prices are finite or null; unknown base units become null.
- Category/inventory references must belong to the active shop on recipe create/update/verify and inventory create/update. Validation runs inside the write transaction, before changes, and locks referenced rows until commit.

Deployment: apply `drizzle/0029_inventory_adjustment_batches.sql` before sending keyed stock adjustments. Existing no-key stock batches do not access the new receipt table. No production migration was applied during implementation.

## Verification

Regression suites and database evidence are recorded here as each phase passes. Real PostgreSQL tests require explicit disposable database URLs; never point them at shared application data.
