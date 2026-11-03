# Fresh Neon schema and authorization inventory

Source boundary: historical SQL through `drizzle/0031_native_document_events.sql` and `src/db/schema/*`. The new baseline is for an empty database; historical account/data backfills and the Supabase ledger are not replayed. This inventory is a design input, not a claim that the new runtime is enabled.

## Relation classification

| Relation | Classification | Baseline treatment and authority |
|---|---|---|
| public.profiles | Identity-adjacent | ID references auth_private.users; own profile writes; preserve user-owned name/avatar |
| public.shops | Tenant root | Membership summaries in user scope; selected owner/admin updates; narrow bootstrap |
| public.shop_members | Identity-adjacent | Unique shop/user; owner/admin/member constraint; controlled membership routines |
| public.audit_logs | Tenant history | Append with verified actor; owner/admin scoped reads; nullable attribution, no runtime update/delete |
| public.categories | Tenant | Selected shop; unique shop/name |
| public.inventory_items | Tenant | Selected shop; existing owner/admin writes and permitted reads |
| public.recipes | Tenant | Selected shop; preserve current lifecycle, costing and soft delete |
| public.recipe_ingredients | Tenant | Parent recipe and optional inventory must share shop; repeated lines remain separate |
| public.receipts | Tenant | Verified upload/approval attribution; preserve extraction/approval split |
| public.receipt_items | Tenant | Parent receipt and optional inventory must share shop |
| public.orders | Tenant | Per-shop sequence; cancellation preserves invoice number; soft delete retained |
| public.order_items | Tenant | Order and recipe belong to same shop; historical recipe-name snapshot |
| public.general_prices | Global reference | Explicit global reads; separately authorized bounded ingestion writes |
| public.product_measurements | Tenant, historical-only export gap | Retain from 0017; unique shop/product_key; no later SQL drops it |
| public.ingredient_conversions | Tenant, historical-only export gap | Retain from 0017; unique shop/scope_key; no later SQL drops it |
| public.media_uploads | Tenant | Ordered sources, uploader and source association immutable; 1–4 sources |
| public.document_versions | Internal tenant sync | Composite shop/kind/id key; trigger/mutation-only writes; scoped reads |
| public.document_mutations | Internal user/shop | Composite shop/id key; originating user owns replay; request identity immutable |
| public.inventory_adjustment_batches | Internal user/shop | Composite shop/id key; request hash + saved response; retained through shop lifetime |
| public.storage_object_deletions | Internal cleanup | No general business access; survives shop/document deletion; bounded enqueue/lease/delete routines |

New private relations: `auth_private.users`, `password_credentials`, `google_identities`, `sessions`, `action_tokens`, `browser_contexts`, `oauth_transactions`, `oauth_completions`, `security_events`, `mail_outbox`; `app_private.job_authorizations` and a fresh migration marker/ledger. Private auth relations are deliberately absent from business exports. No default user/shop/session is seeded.

## Historical evolution retained

- 0000 defines base relations, FKs and indexes. 0001 adds the old external-auth FK, membership helpers, timestamp triggers and RLS; replace the auth linkage/helpers/policies instead of executing them.
- 0002–0014 add content type, processing progress/deadlines, verification, nullable storage path, recipe/order lifecycle/error fields, order item name snapshots, per-shop numbering and plain-text instructions. Both 0006 files are part of lexical history; numbering gaps do not authorize omitting files.
- 0015–0016 introduce shared prices and ingredient lookup names. 0017 adds measurement columns and the two retained tenant relations. 0018 deliberately removes obsolete receipt measurement/application columns and renames unit to src_unit. 0019 removes raw_extraction.
- 0020 narrows legacy numeric columns and removes obsolete costing fields; fresh DDL uses final types/defaults rather than running data reconciliation. 0021–0024 define inventory base-unit totals, receipt base-unit cost and last-20-purchase average behavior, plus raw material names.
- 0025 uses ordered JSON recipe steps, raw_material_name/raw_src_unit, base-unit fields and the current global price layout. 0026 removes ingredient deduplication indexes: repeated material/unit lines must survive.
- 0027 adds upload identity and ordered sources. 0028 adds monotonic document versions, tombstones, idempotent mutation responses and recipe dependency invalidation. 0029 adds inventory batch idempotency. 0030 adds durable storage cleanup. 0031 adds commit-delivered notification hints.

## Constraints, indexes and delete behavior

Retain primary keys, shop slug uniqueness, shop/user membership uniqueness, category and inventory/recipe shop/name uniqueness, inventory shop/SKU partial lookup, recipe shop/storage-path partial uniqueness, shop/status/date indexes, receipt item shop/SKU partial lookup, ingredient parent lookup, global material/SKU uniqueness and SKU lookup. Nullable SKU remains PostgreSQL's normal distinct-null uniqueness; do not introduce account-style normalization into SKU data.

Keep order shop/order_number uniqueness and the atomic `shops.last_order_number` increment in the same transaction as order creation. Never recycle a committed number; cancellation keeps its row/number. Recipe labels on orders use the stored recipe_name before any live-name fallback.

Tenant parents receive `(shop_id,id)` uniqueness with matching child FKs. Cover category links, ingredient recipe/inventory links, receipt items, order/recipe links and upload associations. Keep intended cascade/restrict behavior. Nullable reference deletion clears only the nullable ID, never the required shop_id. Global general_price_id remains a global FK. Shop IDs and creator/resource associations cannot be moved after creation.

Keep the ingredient check `num_nonnulls(inventory_item_id,general_price_id) <= 1`, upload source-count check, document kind check, nonnegative cleanup attempts, paired lease token/expiry, tenant-prefixed storage path, cleanup shop/path uniqueness and due-time index. Add user attribution FKs to mutations/batches while retaining needed history. Record-specific auth uniqueness/expiry/status invariants live in private DDL.

`product_measurements`: id UUID PK/default random; shop_id FK cascade; product_key text; package_quantity numeric(20,6); package_unit text; packages_per_purchase numeric(20,6) default 1; evidence JSONB; updated_at timestamptz default now. All non-null. Unique(shop_id,product_key).

`ingredient_conversions`: id UUID PK/default random; shop_id FK cascade; scope_key text; profile JSONB; updated_at timestamptz default now. All non-null. Unique(shop_id,scope_key).

## Handwritten functions and triggers

Retain updated_at maintenance for shops, profiles, inventory_items, recipes and receipts. Private account timestamps receive equivalent maintenance. Preserve business semantics while fixing owners, grants, search paths and schema qualification.

`track_document_version` backs receipt/recipe/order INSERT/UPDATE/DELETE triggers. Tombstones cover hard deletion, inactive recipes and deleted orders; shop cascade skips recreating removed namespaces. `updated_at` advances monotonically with the transaction's sync_version when supplied, otherwise current milliseconds. The same-edit sync_document_id avoids a false second version bump.

`touch_recipe_sync_version` and `track_recipe_sync_dependencies` cover ingredient insert/update/delete, inventory updates, global-price updates and shop pricing changes. Do not lose invalidations for recipes outside the writer's selected shop when changing a global reference: a separately bounded privileged routine must perform authorized fanout. No broad global-price write grant belongs to ordinary business persistence.

`notify_document_change`/`document_version_notification` publish only a shop UUID on `neuton_document_changes` after commit. LISTEN connection is a hint source; tenant reads and stream authorization use short scoped transactions. No business data goes in notifications.

Storage cleanup retains its queue independently of deleted source rows. Lease claims, retries and completion are separate from network deletion; cleanup needs no surviving membership.

## Runtime persistence conversion map

| Entry point | Required scoped ownership |
|---|---|
| identity.repository, shops.persistence | Verified user scope for own profile/memberships; shop bootstrap and settings use narrow capabilities |
| categories.persistence, inventory.persistence | Shop capability; adjustment replay/audit use same transaction |
| recipe.persistence, recipe-deletion.persistence | Shop capability; costing reads and shared helpers retain supplied handle |
| receipts.persistence, orders.persistence | Shop capability; item updates, stock effects, counters, audit and versioning are atomic |
| analytics.persistence | Shop capability across every aggregate/raw SQL path |
| uploads.persistence | Shop capability for authorization/association; no transaction across R2 |
| sync.persistence | Shop+user capability for version reads and idempotent response replay |
| processing.persistence and worker entry | Persisted job capability per commit stage, never queue shop/user fields |
| lib/audit and shared query/cost/inventory helpers | Explicit caller transaction, no global fallback or second connection |
| StorageCleanupDispatcher in index.ts | Dedicated cleanup pool and bounded routines |

Remove ambient global database constructor defaults as these consumers migrate. Session/Shop guards replace bearer verification with cookie-session resolution; a session DTO is never a capability.

## Role/policy boundary

Migration owner owns DDL only. `neuton_auth` performs private auth lifecycle operations and narrow profile bootstrap; `neuton_app` uses forced business RLS; `neuton_worker` uses persisted job scope; `neuton_cleanup` executes bounded cleanup. Runtime roles cannot own tables, BYPASSRLS, CREATE, TRUNCATE or assume privileged roles.

`neuton_policy_reader` is NOLOGIN with only validity-column and membership reads and its own nonrecursive membership SELECT policy. `neuton_bootstrap` is NOLOGIN with fixed narrow shop/membership routines. Functions have locked search paths, parameterized inputs, explicit grants and no PUBLIC execution. Bootstrap derives the owner from verified transaction context. User/session/membership locks prevent stale authority from committing after revocation.

## Final exported-column inventory

The following inventory is derived from the business Drizzle definitions. A question mark indicates a nullable column. Keep the handwritten-only tables described above in addition to these exports.
audit_logs: id uuid, shop_id uuid, user_id? uuid, ip_address? varchar(45), event_type text, resource_id? uuid, metadata? jsonb, created_at timestamp with time zone
profiles: id uuid, full_name? text, avatar_url? text, created_at timestamp with time zone, updated_at timestamp with time zone
shop_members: id uuid, shop_id uuid, user_id uuid, role text, created_at timestamp with time zone
shops: id uuid, name text, slug text, last_order_number integer, currency char(3), timezone text, store_address? text, target_profit_margin numeric(5, 2), hourly_labor_cost numeric(10, 2), delivery_base_fee numeric(10, 2), delivery_rate_per_km numeric(10, 2), created_at timestamp with time zone, updated_at timestamp with time zone
categories: id uuid, shop_id uuid, name text, created_at timestamp with time zone
general_prices: id uuid, raw_name text, sku? text, raw_material_name text, raw_src_unit? text, src_unit? text, base_unit? text, base_unit_amount? numeric(24, 3), base_unit_cost? numeric(18, 6), created_at timestamp with time zone
inventory_items: id uuid, shop_id uuid, category_id? uuid, name text, raw_material_name text, sku? text, image_url? text, unit text, base_unit text, base_unit_amount numeric(24, 3), base_unit_cost numeric(18, 6), base_unit_average_cost numeric(18, 6), current_quantity numeric(12, 3), reorder_level? numeric(12, 3), last_unit_cost? numeric(12, 4), average_unit_cost? numeric(12, 4), is_active boolean, created_at timestamp with time zone, updated_at timestamp with time zone
recipe_ingredients: id uuid, shop_id uuid, recipe_id uuid, inventory_item_id? uuid, general_price_id? uuid, raw_name text, raw_material_name text, quantity numeric(12, 3), raw_src_unit text, base_unit? text, base_unit_amount? numeric(24, 3), created_at timestamp with time zone
recipes: id uuid, shop_id uuid, category_id? uuid, name text, description? text, image_url? text, prep_time_minutes integer, yield_quantity numeric(12, 3), yield_unit text, target_margin_pct? numeric(5, 2), allergens? text[], steps jsonb, is_active boolean, status text, storage_path? text, error_message? text, created_at timestamp with time zone, updated_at timestamp with time zone
receipt_items: id uuid, shop_id uuid, receipt_id uuid, inventory_item_id? uuid, raw_name text, raw_material_name text, raw_sku? text, quantity? numeric(12, 3), unit_price? numeric(12, 4), total_price? numeric(12, 2), raw_src_unit? text, src_unit? text, src_unit_amount? numeric(12, 3), base_unit? text, base_unit_amount? numeric(12, 3), base_unit_cost? numeric(18, 6), confidence? numeric(4, 3), created_at timestamp with time zone
receipts: id uuid, shop_id uuid, uploaded_by? uuid, storage_path? text, content_type? text, original_filename? text, merchant_name? text, merchant_address? text, receipt_date? date, payment_method? text, total_amount? numeric(12, 2), tax_amount? numeric(12, 2), currency? char(3), status text, progress_stage? text, progress_message? text, processing_started_at? timestamp with time zone, processing_deadline? timestamp with time zone, error_message? text, processed_at? timestamp with time zone, verified_by? uuid, verified_at? timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone
order_items: id uuid, shop_id uuid, order_id uuid, recipe_id uuid, recipe_name? text, quantity numeric(12, 3), unit_cost numeric(10, 2), unit_price numeric(10, 2)
orders: id uuid, order_number integer, shop_id uuid, user_id? uuid, customer_name? text, order_date timestamp with time zone, destination_address? text, delivery_distance_km numeric(8, 2), delivery_fee numeric(10, 2), applied_profit_margin? numeric(5, 2), total_cost numeric(10, 2), total_amount numeric(10, 2), document_url? text, status text, created_at timestamp with time zone, deleted_at? timestamp with time zone
media_uploads: id uuid, shop_id uuid, uploaded_by? uuid, kind text, sources jsonb, receipt_id? uuid, recipe_id? uuid, order_id? uuid, queued_at? timestamp with time zone, processed_at? timestamp with time zone, created_at timestamp with time zone
document_mutations: shop_id uuid, id uuid, user_id uuid, request jsonb, response? jsonb, status integer
document_versions: shop_id uuid, kind text, id uuid, updated_at bigint, deleted boolean
inventory_adjustment_batches: shop_id uuid, id uuid, user_id uuid, request_hash text, response? jsonb
storage_object_deletions: id uuid, shop_id uuid, storage_path text, trace_id text, created_at timestamp with time zone, attempts integer, next_attempt_at timestamp with time zone, lease_token? uuid, lease_until? timestamp with time zone
