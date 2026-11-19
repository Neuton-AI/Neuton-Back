# New Order API rollout

The current frontend stack uses the local recipe catalog and the reviewed
order create contract. The previous frontend calls the quote and orderable
routes from its New Order page. Its service worker prompts for updates and
does not take over running clients automatically, so a published replacement
alone does not prove that older tabs and installed PWAs have stopped using
the old routes.

| Consumer | Replacement | Compatibility during rollout |
|---|---|---|
| `GET /api/v1/recipes/orderable` | Synced recipe documents | Keep the old picker route for cached clients. |
| `POST /api/v1/orders/quote` | Local totals and reviewed create | Keep the old response. An omitted fee uses the store default and the distance rate is zero. |
| `GET /api/v1/shop/delivery-preview` | `deliveryBaseFee` from shop settings | Keep the preview and legacy response shape. Distance is ignored for pricing. |
| Legacy order or shop writes | Reviewed order create and default-fee settings | During rollout keep omitted-fee and legacy distance/rate compatibility. A legacy order client must supply a customer and address to pass current validation. With route removal, new writes ignore the old distance and rate inputs. Legacy order create still accepts omission of review fields. |
| Saved orders and old local documents | Stored fee and historical snapshots | Keep distance and rate columns and legacy read fields. No backfill or financial rewrite is required. |

Apply the additive backend migrations and publish the reviewed frontend in a
coordinated rollout. Ask users of older tabs to refresh. During the update
window, those tabs must supply both customer fields even though their form
marks the fields optional. Roll back with the compatibility
routes still present, and keep the additive fields and historical values.

Before deploying the separate removal change, check the existing
`http_request_completed` logs for the old route and method pairs across API
instances, and check `legacy_order_create_contract` for validated legacy
create payloads. Track 400s on the create route separately during rollout,
since invalid bodies do not receive the legacy marker. Confirm zero legacy
usage across the supported client update window and verify documented
consumers have switched. Check the `fields` metadata of `SHOP_UPDATED`
audit rows for `deliveryRatePerKm` in the same window. Record the frontend
and backend release revisions, the interval and the counts in #276. Roll back
to the compatibility release if legacy traffic reappears.

The removal change unregisters the three legacy handlers. The old quote
and delivery-preview URLs return 404. The old orderable URL falls through
to recipe detail and is rejected as a non-UUID without a database lookup.
Existing order and shop delivery fields remain readable. New shops use
the existing database default of zero for the historical rate column.
No schema change or historical rewrite is required.

Malformed legacy recipes remain available for manual remediation. This work
keeps their saved rows and the existing pricing-error behavior.
