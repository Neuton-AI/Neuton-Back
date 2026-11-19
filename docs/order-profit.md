# Partial-cost order profit

Every sale contributes its full charged amount to revenue and its known cost to production-cost reporting. A line whose saved `costComplete` is false contributes exactly zero profit. Complete lines retain their pricing/profit policy; unknown legacy completeness is not relabelled as partial. Delivery fees remain excluded from profit and recorded expenses retain their existing treatment.

## Preserving calculation precision

The pricing provider calculates known unit cost to four decimals, while historical order lines store two-decimal costs. Recomputing a mixed order from those lines can change its complete-line profit: a complete line priced at 2.00 with raw cost 1.2345 and quantity 3 contributes 2.30 at creation, but its stored 1.23 unit cost would imply 2.31.

New orders containing any partial line therefore freeze the calculated two-decimal profit in nullable `orders.profit_snapshot`, in the same transaction as their lines and totals. An explicit zero is a known snapshot. This internal field does not appear as a new public DTO field. Widening historical line storage would not recover already-lost precision and would change existing complete-line top-item accounting, so the existing line precision is retained.

Reads use the snapshot when present. For pre-snapshot partial records, only saved two-decimal line evidence is available: exclude false-completeness line profit and retain complete/unknown line margins. Exact original four-decimal mixed profit cannot be recovered from those legacy records. Complete/unknown orders without a partial line retain their stored header formula. No financial row is backfilled or rewritten by migration 0041.

The shared SQL profit/correction expressions feed order list/detail (and sync downloads), current/previous dashboard totals, daily graph, recent orders, and average/median order profitability. They correlate lines by order and shop and use the existing order-items order-ID index. Top-item reporting preserves its existing saved two-decimal complete-line accounting and excludes partial-line margins. Revenue, delivery and known production-cost totals remain separate facts; profit corrections do not inflate reported costs. Currency results are rounded so floating-point subtraction cannot turn a frozen zero into residual profit.

The document-processing writer replaces lines and totals atomically and clears any old profit snapshot in that same transaction. Its existing complete-cost guard remains in force. Changes to current recipe names, status, costs or shop pricing do not recalculate saved profit.

## Rollout and rollback

Apply nullable, no-default migration 0041 before deploying code selecting the field. Coordinate T05/T07 provider contracts, T16 accounting, and the frontend workflow before production rollout. Application rollback restores the old calculation behavior while leaving captured snapshots and financial history intact; dropping the column is not the rollback procedure. No physical historical-column cleanup is authorized.

Verification includes pure complete/partial/zero and rounding cases, existing order/analytics/worker tests, and disposable PostgreSQL create/read/sync/reporting and migration-preservation scenarios. T17's deprecated caller/API audit and T15's final initiative verification remain separate tasks.
