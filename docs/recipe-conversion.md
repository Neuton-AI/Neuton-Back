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

## Manual recipe products

`POST /recipes/:id/manual-product` receives package pricing separately from recipe
usage: `packageSize`/`packageUnit` describe the purchase, while `quantity`/`rawSrcUnit`
are the user's final amount used in the recipe. These usage fields must normalize
to the package's base unit; they do not need to match the old extracted ingredient.
Both amounts use the existing recipe converter. Invalid or unrepresentable amounts
are rejected before inserting a price.

Manual products create independent `general_prices` rows with no SKU; they do not
create inventory or overwrite an existing shared product price. The manual name
replaces both ingredient and material names. The response contains `product`
(including `id`, `name`, package `baseUnitAmount` and `baseUnitCost`) and `usage`
(the converted recipe ingredient, including its `baseUnit` and `baseUnitAmount`).
The editor uses `product.id` as `generalPriceId`, clears `inventoryItemId`, and shows
the normalized usage. Recipe Save persists that replacement and recalculates costs.
After a recipe edit is acknowledged, local sync queues a durable detail refresh to
retrieve those calculated costs, even when the local and server revisions match.
The existing pull revision guard protects edits made while that refresh is pending.

The manual form always shows a required recipe usage field, with units restricted
to the package's weight, volume, or count type. All manual amount fields start empty;
neither quantities nor selected units are inferred from the extracted ingredient.
Compatible unit changes convert only amounts the user entered; switching measurement
types clears the amount. UI unit choices/ratios mirror `supermarket/conversion.ts`
for display; submission validation, normalization and pricing remain server-owned.
