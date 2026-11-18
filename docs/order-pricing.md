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
epsilon yield is used. The shared `calculateOrderPricing` policy is available
for order creation integration.

This provider is additive. It does not activate partial-cost order creation or
change existing saved orders. Migration `0039_recipe_order_pricing_sync.sql`
advances active recipe document revisions once so initialized clients pull the
projection through normal sync. It keeps future revisions monotonic, leaves
tombstones and other document kinds unchanged, and never updates financial or
recipe rows. Existing dependency triggers invalidate snapshots after ingredient
inserts/edits/deletes, inventory average-price changes, general-price changes and
shop labor/margin changes. Reactivation downloads current pricing even when
dependencies changed while the recipe was inactive.

Apply the backend migration before switching New Order to this projection. Old
frontend clients tolerate the additive response; new clients derive documented
legacy prices until refreshed. Rolling back application code can leave advanced
sync revisions in place: they cause a harmless extra download and must not be
decremented. No dedicated pricing fetch or polling loop is needed. Complete-recipe
markup replacement remains outside this initiative.

Source: [T01 #269](https://github.com/Neuton-AI/Neuton-Back/issues/269) and
[T02 #270](https://github.com/Neuton-AI/Neuton-Back/issues/270), under
[New Order #268](https://github.com/Neuton-AI/Neuton-Back/issues/268).
