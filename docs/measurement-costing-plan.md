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

- [ ] Proportional package costing: 50g / 250g × 10 = 2 across all entry points.
- [ ] Purchases: 2 × 500g / 14 = 1000g at .014/g; mixed kg/g average; weighed lemons preserve 9.16 paid.
- [ ] Same dimension, ounces/fluid ounces, fractions, Hebrew aliases, explicit grams, eggs size and yield 16.
- [ ] Missing quantity/unit/price/yield, conflicts and ambiguous conventions remain unresolved.
- [ ] Exact codes preserve leading zeros and chain scope; no partial-code enrichment.
- [ ] Catalog gouda/vodka/cheddar/belt fixtures, raw metadata and source timestamps, cache and concurrent deduplication.
- [ ] Saved corrections and multipacks; actual paid amount and discounts; currency mismatch.
- [ ] Sourced versioned baking profiles including baking powder; shop/product overrides; alternatives preserved.
- [ ] Null unknown line costs, known subtotal, readiness and no incomplete automatic retail/profit claim.
- [ ] Repeated lines persist; normalized stock aggregated; estimates never create stock.
- [ ] Pending-to-applied transactional exactly-once receipts including retries and concurrent rows.
- [ ] Precision (quantities 6 decimals, rates 10 decimals) and output rounding boundaries.
- [ ] Product/offer identity independent of name; retrieval outside stock write transactions.
- [ ] Migration report and legacy reconciliation; completed financial history unchanged.
- [ ] Consistent API/UI resolution scope and invalidation.
- [ ] Backend/frontend checks plus meaningful regressions.
- [ ] Chrome DevTools supplied-document flow and UI evidence (or record concrete infrastructure blocker).

## Rollout

Ship additive migration before application changes. Legacy balances initially require reconciliation unless trusted purchase evidence can reconstruct them; no blanket mass/count relabeling. Existing completed order money is immutable. Run the migration audit before reconciling opening balances. Deploy backend before frontend; nullable costing fields require the paired UI.

## Verification log

To be updated at each checkpoint. GitHub CLI initially needed network permission; connector successfully read the existing issue. No duplicate issue is needed despite stale local draft metadata.
