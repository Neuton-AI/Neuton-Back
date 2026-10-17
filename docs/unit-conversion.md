# Recipe and product measurement conversion

`convertRecipeToBaseUnits` returns a new full recipe and new ingredient objects.
Only `baseUnit` and `baseUnitAmount` are enriched. Raw names, quantities, units,
steps, links and other properties are preserved. The worker calls it before
writing either new or previously queued recipes.

`convertMeasurement` in `src/lib/unitConversion.ts` is the shared conversion core
for recipes and receipt/product amounts. Recipe callers supply the quantity
required by the recipe line. Receipt/product callers supply package contents;
neither core conversion nor recipe conversion multiplies by a package size or
purchased package count.

Canonical units are `g`, `ml` and `each`. Supported dimensions:

| Dimension | Units |
| --- | --- |
| Mass | mg, g, kg, oz, lb |
| Volume | ml, l, explicitly US tsp/tbsp/cup |
| Count | each/unit/piece, dozen |

The core lists English singular/plural and Hebrew aliases. Case, whitespace,
periods and Hebrew/English quotation marks are normalized. Only complete unit
aliases match: arbitrary product descriptions are not treated as measurement
metadata. Decimal numbers, simple fractions (`1/2`), mixed fractions (`1 1/2`),
and common Unicode fractions (`½`, `1½`) are supported. The recipe parser uses
the same quantity parser so fractions survive extraction.

Both base fields are `null` for unresolved lines. The core also returns an
`unresolvedReason`: `invalid-quantity`, `unsupported-unit`, `incompatible-unit`,
or `invalid-base-amount`. Missing, nonpositive, nonfinite or malformed quantities,
missing units, packs/bags of unknown size, pinches, and bare household measures
(`cup`, `tsp`, `tbsp`, `כוס`, `כף`) are unresolved. US measures must be explicit
because household sizes vary. This also replaces the old receipt table's implicit
US household factors and incorrect pack-to-piece assumption. No density or piece
weight is inferred, and an explicit incompatible target dimension is rejected.

Migration 0026 allows missing extracted quantity/unit to remain SQL NULL instead
of fabricating `1 unit`. Existing data is unchanged. Amounts retain the existing
numeric(24,3) storage precision; conversions in the utility are unrounded.
Deploy this migration before the worker. Manual recipe editing continues to
require a positive quantity and explicit unit; broader costing/display work is
tracked in #153.
