# Recipe order pricing

Recipe list (`GET /api/v1/recipes`) and detail (`GET /api/v1/recipes/:id`)
responses include a derived `orderPricing` property on each recipe. Detail
downloads with `x-sync-snapshot: true` include the same projection and the
existing stable `syncVersion` envelope.

```json
{
  "orderPricing": {
    "unitPrice": "3.33",
    "unitCost": "3.3333",
    "costComplete": false
  },
  "orderPricingError": null
}
```

`unitCost` is the resolved ingredient subtotal plus batch labor, divided by
positive recipe yield and rounded to four decimal places. Complete recipes use
the existing retail markup, with recipe margin overriding shop margin. Partial
recipes sell at known unit cost without markup. Charged `unitPrice` is normalized
to two decimal places using the existing money helpers. Missing ingredient
prices remain unresolved; valid zero prices, empty ingredients and labor-only
partial costs are supported. Inventory stock does not suppress the projection.

The existing `costing` object preserves its meaning: incomplete recipes retain
null `unitCost`, `batchCost` and `retailPrice`, alongside known `ingredientsCost`
and `laborCost`. The projection does not claim that partial cost is complete.

Invalid or nonpositive yield produces `orderPricing: null` and
`orderPricingError: { code: "INVALID_RECIPE_YIELD", message: "Recipe yield must be a finite positive number" }`.
Other recipes still load. No recipe is repaired or deleted, and no artificial
epsilon yield is used. The shared `calculateOrderPricing` policy also supplies reviewed order creation.

Reviewed creation uses the complete/partial projection and snapshots its provenance; existing saved orders are not recalculated. Dependency sync rollout and migration of existing
local snapshots are tracked separately in T02; adding response fields alone does
not invalidate previously initialized clients. Complete-recipe markup replacement
remains outside this initiative.

Source: [T01 #269](https://github.com/Neuton-AI/Neuton-Back/issues/269), under
[New Order #268](https://github.com/Neuton-AI/Neuton-Back/issues/268).
