# Issue #136 — measurement costing implementation

Issue: https://github.com/Neuton-AI/Neuton-Back/issues/136
Branch in both repositories: `bug/FB/n136-recipe-measurement-costing`.

## Contract

Canonical quantities are g, ml, each. Identity and measurement readiness are independent. Unknown costs are null; known zero is valid. External prices and ingredient density conversions are estimates and never create stock. Preserve original evidence and version conversion assumptions. Never change completed order snapshots or reinterpret ambiguous legacy balances.

## Checkpoints

1. Deterministic measurements, fraction parsing, ingredient profiles, purchase normalization and regression fixtures.
2. Additive persistence, safe legacy migration/report, catalog adapters/cache/exact lookup, extraction evidence.
3. Transactional receipt application and deferred correction, scoped saved metadata, inventory reconciliation.
4. Shared recipe/order/worker costing and stock aggregation, nullable costs and auditable order snapshots, analytics readiness.
5. Frontend receipt/recipe/inventory/order contracts and focused resolution controls.
6. Full regression checks, Chrome DevTools manual validation, cleanup, push, linked PRs and board transition.

## Acceptance tracker

- [x] Proportional package costing: 50g / 250g × 10 = 2 across all entry points.
- [x] Purchases: 2 × 500g / 14 = 1000g at .014/g; mixed kg/g average; weighed lemons preserve 9.16 paid.
- [x] Same dimension, ounces/fluid ounces, fractions, Hebrew aliases, explicit grams, eggs size and yield 16.
- [x] Missing quantity/unit/price/yield, conflicts and ambiguous conventions remain unresolved.
- [x] Exact codes preserve leading zeros and chain scope; no partial-code enrichment.
- [x] Catalog gouda/vodka/cheddar/belt fixtures, raw metadata and source timestamps, cache and concurrent deduplication.
- [x] Saved corrections and multipacks; actual paid amount and discounts; currency mismatch.
- [x] Sourced versioned baking profiles including baking powder; shop/product overrides; alternatives preserved.
- [x] Null unknown line costs, known subtotal, readiness and no incomplete automatic retail/profit claim.
- [x] Repeated lines persist; normalized stock aggregated; estimates never create stock.
- [x] Pending-to-applied transactional exactly-once receipts including retries and concurrent rows.
- [x] Precision (quantities 6 decimals, rates 10 decimals) and output rounding boundaries.
- [x] Product/offer identity independent of name; retrieval outside stock write transactions.
- [x] Migration report and legacy reconciliation; completed financial history unchanged.
- [x] Consistent API/UI resolution scope and invalidation.
- [x] Backend/frontend checks plus meaningful regressions.
- [x] Chrome DevTools supplied-document flow and UI evidence (or record concrete infrastructure blocker).

## Rollout

Apply migration 0017 before application changes. All pre-existing balances require confirmed reconciliation: receipts alone cannot establish remaining stock or consumption. Existing completed order money is immutable. Run the read-only migration audit before and after migration. Deploy the paired backend and frontend together, backend first; nullable costing fields require the new UI. Do not roll application code back against the migrated database without a compatibility plan.

## Verification log

Implementation checkpoints were committed separately for deterministic normalization, persistence and shared costing, frontend corrections, concurrency and extraction validation, and final integration. GitHub read the existing issue; no duplicate issue was created despite stale local draft metadata.

Final backend verification: `NEUTON_OFFLINE_TESTS=1`, local `NEUTON_TEST_DATABASE_URL`, `npm run verify`: 225 passed, zero failed or skipped; production/test type checks and build passed. `npm run db:validate` passed all SQL files. The real PostgreSQL test verifies deferred receipt races, mixed units, saved multipacks and shop isolation, opposite new-item ordering, catalog/quote/worker consistency, and immutable delivered snapshots.

Final frontend verification: `npm run verify`: 221 passed across 21 files; lint, type check and build passed. Three existing Fast Refresh warnings remain, with zero lint errors.

All final SQL files were applied through the normal checksum migration runner to a fresh isolated PostgreSQL 18 database. A separate pre-0017 legacy fixture proved preservation of quantity 8, unit `unit`, average 6.9, a verified purchase and a delivered order with cost 2/revenue 10. The audit reports `legacy_basis_unproven` before migration and `legacy_reconciliation_required` afterward; old receipt lines become `legacy_applied`, completed order money stays unchanged.

Chrome DevTools verification used the specified test account and testShop, with all application writes isolated in local PostgreSQL. The local Israeli fixtures use ILS; the remote account membership reports USD, so the UI uses the costing/snapshot currency returned by the API. Screenshots are committed in the paired frontend repository under `docs/visual-proof/n136-measurement-costing`.

Manual results: proportional butter cost 2 ILS; contradictory cheddar metadata stays unresolved until an explicit shop-scoped 200g correction; pending butter package contents resolve once, and a repeated application returns 409 with stock unchanged at 750g. The supplied receipt was reviewed/corrected to add 1000g cornstarch at .014 ILS/g and 925g lemons at the actual 9.16 ILS paid; margarine remains pending without package contents. Bags and the spurious OCR charge are excluded from stock. The supplied brownie retains all nine ingredients, explicit gram quantities, quarter-teaspoons, eggs/count qualifier and yield 16. Its incomplete order requires an explicit selling price and keeps production cost/profit unknown.

Actual Gemini extraction was performed on both supplied images with user approval. The brownie was correctly read. Receipt extraction misread several item names/count-price pairings and the date; manual corrections were necessary. Review remains required. The source does not state a cup/spoon convention, so a model guess without quoted source evidence is rejected. Valid exact-code enrichment, catalog cache/concurrency and contradictions are verified with deterministic fixtures. A live Carrefour request returned no usable package evidence and correctly left the line pending. Live catalog availability for every supplied barcode, R2 upload/preview and Redis queue transport were not verified; actual extraction output was passed through the real worker handlers with isolated dependencies instead.

See [measurement-costing-verification.md](measurement-costing-verification.md) for deployment and precision details.
