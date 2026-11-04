# Business authorization on Neon

Business services enter a selected-shop transaction through `ShopOperation.run` and their persistence factory's `inShop` callback. The boundary installs transaction-local identity context, resolves current membership, and keeps the session/security/membership locks until commit. The actor supplied inside the callback contains the current database role. Services enforce their existing action permissions again inside that boundary.

Persistence factories accept the application connection or an existing `ShopTransaction`. Their database getter refuses an unbound factory. A scoped instance exposes only the transaction handle. Passing an existing capability keeps work on that handle; it does not open another connection. A capability cannot be used with a different actor, session, or shop.

Categories, inventory, recipes, receipts, orders, and analytics use these boundaries for business reads and mutations. Audit inserts, inventory adjustment claims, receipt application, document triggers, and sync mutation receipts commit with the business change. Logging effects run after the owning commit. When a sync operation supplies an outer transaction, its owner receives the logging effects and discards them on rollback.

## Restricted operations

- Shared prices remain globally readable. Writes use `app_private.upsert_general_price`; the application role has no direct global price mutation grant. Existing dependency triggers deliberately invalidate affected recipes across shops.
- Order numbering uses `app_private.next_order_number` on the same transaction as pricing, order creation, and line inserts. Delivery verification uses `app_private.mark_order_delivered`. Cancellation preserves the issued number and historical line snapshots.
- File deletion intent uses `app_private.enqueue_storage_deletions`. Request handlers enqueue intent without calling object storage during deletion.
- Recipe deletion attempts a hard delete within a savepoint. A referencing order causes deactivation instead; metadata removal, tombstones, cleanup intent, and audit remain atomic. Migration `0011_business_operations.sql` permits application-role upload deletion only for an inactive recipe in an administratively authorized shop.

## External operations

Barcode lookup first resolves the authorized recipe in a short transaction. The external lookup runs after commit. Another shop transaction resolves current access and the resource again before saving the normalized shared price.

Uploads derive creator and shop attribution from verified identity. Resource rows and upload metadata are inserted atomically with the final resource association; later updates cannot establish or change the association. Initial-request retries compare kind, resource association, and ordered source declarations before reusing stored sources.

Upload renewal and completion resolve the associated live resource. Completion reads authorized metadata, checks object size and content type outside a transaction, then resolves current membership, resource association, and upload state again before committing readiness. Resource locks precede upload locks. Queue dispatch runs after readiness commits. Download signing first resolves a matching stored receipt/source/preview path in a shop transaction; a matching path prefix alone grants no access.

## Phase boundaries

Members, admins, and owners may create orders, read them, request quotes, and verify delivery. Members create processing orders attributed to their verified account and insert lines only for their own processing orders. Updates and cancellation remain administrative; delivery verification uses the narrow routine. Migration `0012_member_order_creation.sql` enables member creation and scoped number allocation without granting members direct shop-counter updates.

Persisted worker authorization, restricted cleanup dispatch, sync read/snapshot scoping, and continuous event-stream reauthorization belong to Phase E. Browser business consumers and offline synchronization belong to Phase F. These later phases remain necessary before the complete Supabase cutover.

No additional environment variables are required by Phase D.
