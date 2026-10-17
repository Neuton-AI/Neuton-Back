# Recipe base-unit conversion

`convertRecipeToBaseUnits` preserves the full extracted recipe, including original
ingredient fields and ordered steps, and returns new ingredients with `baseUnit`
and `baseUnitAmount`. The recipe worker applies it before either ingredient insert
path. It calls the existing supermarket/receipt regex matcher and amount converter;
the existing conversion mechanism is unchanged. The shared table also supports
milligrams at 0.001 grams per milligram.

English singular/plural names and abbreviations now cover milligrams, grams, kilograms,
milliliters/litres/liters, ounces, pounds, teaspoons, tablespoons, cups, pieces,
units, each and dozens. Existing Hebrew aliases remain available. English matching
is case-insensitive. Plain `cup`, `tbsp`, and `tsp` use the existing ratios
(236.588, 14.7868, and 4.92892 ml respectively), without a regional prefix.

Both base fields are null for missing units, nonpositive/nonfinite/missing numeric
quantities, unknown units, packages with unknown contents, compound measures and
qualified measures such as `heaped tbsp`. Fractional numeric
quantities, such as 0.2 or 0.5, use the same multiplication as receipts.

Mass stays mass, volume stays volume, and count stays count. No density or piece
weight is inferred. Ingredient quantities are never multiplied by product package
sizes, and supermarket enrichment is not used to resolve recipe measures.
