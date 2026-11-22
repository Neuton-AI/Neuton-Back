# New Order API rollout

This release pairs the backend in Neuton-AI/Neuton-Back#287 with the
frontend in Neuton-AI/Neuton-Front#249. The backend release includes
migrations 0039 through 0041 and removes the legacy pricing routes.

| Removed route or input | Replacement |
|---|---|
| GET /api/v1/recipes/orderable | Synced recipe documents |
| POST /api/v1/orders/quote | Local totals and reviewed order creation |
| GET /api/v1/shop/delivery-preview | The fixed delivery fee from shop settings |
| Distance and per-kilometre rate write fields | Final order fee and shop default fee |

Verify the paired builds together, apply the additive migrations, then
publish the backend and frontend in the same release window. Verify
recipe sync, reviewed checkout, and saved-order reads after publishing.
Older tabs and installed PWAs may need a refresh to load the new client.
Their picker or quote calls fail against the new backend.

The old quote and preview URLs return 404. The old orderable URL reaches
recipe detail and fails UUID validation before a database lookup.
Historical order distances, delivery fees, shop rates, and financial
snapshots remain readable. New shops use the existing database default
of zero for the historical rate column. The removal does not add a
migration or rewrite stored values.

If old clients need to be restored, use the backend compatibility
revision from #285. Keep the additive migrations and historical values
in place. Malformed legacy recipes remain available for manual remediation.
