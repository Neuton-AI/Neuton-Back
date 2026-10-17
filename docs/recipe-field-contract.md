# Recipe field contract — phase 1 (#149)

`steps` is a non-null JSONB array of `{ stepNumber, instruction }`, numbered from
1 in display order. Empty instructions become `[]`; legacy nonempty text is kept
verbatim as one step so punctuation, newlines and numbering are never lost.

Recipe lines retain IDs, raw text, quantity and both foreign keys. The source
unit is `rawSrcUnit`; `rawMaterialName` replaces the former search name. Nullable
`baseUnit` and `baseUnitAmount` describe the **total requirement of the line**.
Extraction persists null base fields until phase 2 establishes conversions; the
model cannot assert a density or package size from an ambiguous source unit.

Amounts use NUMERIC(24,3), like inventory total base amounts; costs use
NUMERIC(18,6), like receipt base costs. They are decimal strings at database/API
boundaries, not floating point storage. Recipe source quantity remains
NUMERIC(12,3), non-null. Amount/cost fields have no zero default. Null means
unresolved; missing costs must never be inferred as free ingredients.

`general_prices` has exactly id, created_at, raw_name, sku, raw_material_name,
raw_src_unit, src_unit, base_unit, base_unit_amount, base_unit_cost. ID and
created_at are non-null with defaults; raw_name and raw_material_name are
non-null text. All other fields are nullable. Its base amount describes the
**product contents represented by the price**, not a recipe requirement.

Migration 0025 renames existing columns in place, retaining IDs and recipe
references. Exact g/kg/ml/l/unit/each conversions are backfilled; cups, packs,
densities and other unknowns remain null. Supermarket cost is derived only from
positive legacy package quantity, a recognized package unit and positive price.
The old price_per_base_unit is ignored because its basis is unproven. Costs that
would overflow NUMERIC(18,6) or round down to zero also remain unresolved.

The unique (raw_material_name, sku) index permits the same SKU for different
material queries and provides a leading material lookup index. A separate SKU
index supports SKU searches. Historical null SKUs are retained as distinct rows;
the runtime writer skips products without a SKU. Material queries use the same
normalizer for lookup and upsert. Until phase 4 supplies proven product
conversions, fallback searches cache source metadata with null base fields.

Pricing reads inventory.baseUnitAverageCost for inventory links and
general_prices.baseUnitCost for supermarket links. A positive recipe base amount
and matching base units are required. A preserved unresolved link is exposed as
`linked: false` and cannot make the recipe fully costed.

## Deployment coordination

Release migration 0025, backend and frontend PRs together during a worker/API
pause. Old runtimes reference removed columns and cannot run against this schema.
Take a database backup first: removed supermarket metadata cannot be recreated
by rolling code back. Phase 2 (#150) fills recipe conversions; phase 3 (#151)
completes costing/order/stock behavior; phase 4 (#152) resolves supermarket
conversions; phase 5 (#153) completes review interactions. Until those phases are
released, newly extracted lines remain incomplete rather than appearing free.
Do not deploy phases 2–5 against the old schema. Restore the backup to roll back
this migration; do not amend previously applied migration files.
