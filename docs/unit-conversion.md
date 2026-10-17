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
| Volume | ml, l, tsp, tbsp, cup |
| Count | each/unit/piece, dozen |

The core retains the Hebrew mass, volume and count regexes and adds parallel
English regexes. The conversion loop checks both language groups within each
measurement category. Regex boundaries prevent matches inside longer words;
English patterns ignore case and Hebrew patterns handle unit quotation marks.
As in the original receipt matcher, unit tokens can occur within measurement
text (`200 g`, `משקל ק״ג`). Package tokens are recognized separately and have
no conversion factor because their contents are unknown.
Decimal numbers, simple fractions (`1/2`), mixed fractions (`1 1/2`),
and common Unicode fractions (`½`, `1½`) are supported. The recipe parser uses
the same quantity parser so fractions survive extraction.

Both base fields are `null` for unresolved lines. The core also returns an
`unresolvedReason`: `invalid-quantity`, `unsupported-unit`, `incompatible-unit`,
or `invalid-base-amount`. Missing, nonpositive, nonfinite or malformed quantities,
missing units, packs/bags of unknown size and pinches are unresolved.
The reasons are defined by `MeasurementUnresolvedReason`, with `UnresolvedReason`
derived from its members and used by `MeasurementConversion`.
Bare `tsp`/`teaspoon`, `tbsp`/`tablespoon`, and `cup` (including plurals and Hebrew
equivalents) convert using the existing factors: 4.92892 ml, 14.7868 ml and
236.588 ml respectively. No density or piece
weight is inferred, and an explicit incompatible target dimension is rejected.

Migration 0026 allows missing extracted quantity/unit to remain SQL NULL instead
of fabricating `1 unit`. Existing data is unchanged. Amounts retain the existing
numeric(24,3) storage precision; conversions in the utility are unrounded.
Deploy this migration before the worker. Manual recipe editing continues to
require a positive quantity and explicit unit; broader costing/display work is
tracked in #153.
