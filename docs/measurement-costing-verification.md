# Issue 136 verification and rollout

Issue: https://github.com/Neuton-AI/Neuton-Back/issues/136

## Deployment

1. Back up the database and run `npx tsx scripts/measurement-audit.ts` against the intended deployment database before migration. This report is read-only and understands both schemas.
2. Apply `npm run db:migrate`, including `0017_measurement_costing.sql`, before the new backend. Deploy the paired frontend immediately after the backend.
3. Run the audit again. All pre-existing inventory is deliberately `legacy_reconciliation_required`. Confirm the opening quantity, canonical unit and cost together through the inventory correction control before using it for new cost/stock calculations.
4. Review accepted pending receipt lines. A verified receipt may contain accepted purchases that have not yet changed stock. Resolve each purchase explicitly; a successful application cannot be repeated.
5. Monitor unresolved recipes and pending purchases. Do not infer a complete production cost from a known subtotal.

This migration is a one-way financial domain change with wide impact. It increases precision, makes new cost snapshots nullable, adds scoped measurement tables, and removes ingredient uniqueness to allow repeated lines. A direct old-code rollback could resume unsafe calculations or recreate incompatible constraints. Historical completed money is preserved; no migration reconstructs consumed stock from purchase receipts alone.

## Precision and assumptions

- Canonical quantities use g, ml or each, with six decimal places in persisted balances/requirements/package contents. Rates use ten decimal places. Calculations accumulate before currency rounding; price/output accounting values round at the defined money boundary.
- Exact same-dimension tests use tolerance 1e-9; weighted total value is checked within 1e-6. Receipt count-price agreement allows 0.011 in the receipt currency to account for printed cent rounding. Discounts beyond that require explicit confirmation.
- Weight ounces use 28.349523125 g; pounds use 453.59237 g. Fluid ounces remain volume. Supported US, metric and imperial volume conventions are explicit. Missing conventions remain unresolved.
- Ingredient density estimates use the versioned King Arthur chart profile (`ka-2026-10-v1`), scoped to recognized ingredient names and matching convention/qualifiers. Baking powder is 4g per US teaspoon, so .25 tsp is an estimated 1g. No universal spoon-to-grams factor exists.
- Sources: https://www.kingarthurbaking.com/learn/ingredient-weight-chart and https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b9
- User corrections have explicit recipe, ingredient or product scope, with shop isolation, saved version and evidence. A changed product/link invalidates inappropriate previous measurement evidence.
- External catalog observations remain estimates, never create stock and never replace the amount actually paid. Currency mismatches remain unresolved; there is no implicit foreign-exchange conversion.

## Completed checks

Backend `npm run verify`: 225 tests passed, zero skipped, both type checks and build passed, using offline service stubs and an isolated local PostgreSQL integration database. `npm run db:validate` passed all migrations. Frontend `npm run verify`: 221 tests passed, lint/type check/build passed; three pre-existing Fast Refresh warnings.

The full migration runner accepted a fresh PostgreSQL 18 database. A separate pre-migration seeded fixture preserved legacy inventory values, marked old verified receipt lines `legacy_applied`, and preserved delivered order/line monetary values and snapshot status. Audit behavior was checked before and after migration.

Real database coverage includes pending purchases without stock changes, concurrent deferred application (one success), mixed kg/g weighted averages, saved multipacks reused in purchases and public costing, isolation from another shop, opposite new-item insertion ordering without deadlocks, and shared catalog/order quote/worker costs. A delivered order remains unchanged after a price update and a late worker delivery. Extraction retry tests protect reviewed recipes.

Chrome DevTools exercised the supplied documents and correction controls, contradictory catalog metadata, normalized stock, shared quote currency, repeat protection and incomplete-order manual pricing. Evidence and details are in the paired frontend's `docs/visual-proof/n136-measurement-costing` and `docs/measurement-costing-verification.md`.

## Verification limits

Gemini read the supplied brownie correctly but receipt OCR required corrections to names/counts/prices and misread the date. The UI does not make unresolved purchases change stock; review is required. No source evidence stated the brownie cup/spoon convention, so guessed conventions are not accepted.

Exact valid codes, leading zeros, retailer scope, compatible alternate sources, conflicting metadata and catalog cache behavior have deterministic fixture coverage. Live Carrefour lookup returned no usable package evidence for the pending source line. Live coverage for every supplied barcode was not established. R2 upload/preview and Redis queue transport were not exercised; approved live Gemini results were sent through the actual worker handlers using private local dependencies. No shared application database writes were made.
