# Order snapshots

Orders expose `deliveryDate` as a calendar string (`YYYY-MM-DD`) or `null`. Create accepts an optional valid calendar string. Legacy clients may omit it; omission stores null rather than inventing a date from `orderDate`. Explicit null or timestamps are rejected on input. `orderDate` remains an ISO timestamp with the existing offset conversion. There is no earlier-delivery-date restriction.

Order detail lines expose `costComplete: boolean | null`. Creation freezes the server-derived costing result. Caller-supplied completeness is ignored. Null means historical provenance was not recorded and must retain its existing accounting treatment, not be interpreted as false. Amounts, costs and names remain their original snapshots. The current create policy still admits only complete costing; partial-price creation and accounting are separate T06/T16 work.

Migration `0040_order_snapshots.sql` adds nullable PostgreSQL `date` and `boolean` columns without defaults or a backfill. It changes no existing invoice number, amount, name, cost or fee. Number 0039 is reserved for the independent T02 rollout PR. This repository's migration runner scans SQL files and checksums directly; its generated Drizzle journal ends at 0027, so no stale generated snapshot/journal is advanced for this handwritten migration.

Apply the additive migration before deploying code that selects these columns. Roll back by reverting application code and retaining the nullable columns, preserving any newly recorded snapshots. Do not drop the columns as an application rollback: doing so would destroy the newly captured provenance.

Implementation uses [Drizzle date string mode and nullable column builders](https://orm.drizzle.team/docs/column-types), checked against installed Drizzle 0.38.4, and [Zod 3 calendar date validation](https://v3.zod.dev/?id=dates-1), checked against installed Zod 3.25.76. Snapshot reads reuse the same detail DTO as normal reads.
