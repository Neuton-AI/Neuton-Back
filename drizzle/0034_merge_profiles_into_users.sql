ALTER TABLE public.users
  ADD COLUMN full_name text,
  ADD COLUMN avatar_url text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
LOCK TABLE public.profiles IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE neuton_legacy_profiles ON COMMIT DROP AS
SELECT p.id FROM public.profiles p
WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p.id);

CREATE TEMP TABLE neuton_legacy_receipts ON COMMIT DROP AS
SELECT id, shop_id, storage_path
FROM public.receipts
WHERE uploaded_by IN (SELECT id FROM neuton_legacy_profiles)
   OR verified_by IN (SELECT id FROM neuton_legacy_profiles);

CREATE TEMP TABLE neuton_legacy_orders ON COMMIT DROP AS
SELECT id, shop_id, document_url
FROM public.orders
WHERE user_id IN (SELECT id FROM neuton_legacy_profiles);
--> statement-breakpoint
-- Remove and capture uploads before the receipt and order FKs cascade.
CREATE TEMP TABLE neuton_legacy_uploads ON COMMIT DROP AS
WITH removed AS (
  DELETE FROM public.media_uploads
  WHERE uploaded_by IN (SELECT id FROM neuton_legacy_profiles)
     OR receipt_id IN (SELECT id FROM neuton_legacy_receipts)
     OR order_id IN (SELECT id FROM neuton_legacy_orders)
  RETURNING shop_id, sources
)
SELECT * FROM removed;

DELETE FROM public.receipts r USING neuton_legacy_receipts legacy WHERE r.id = legacy.id;
DELETE FROM public.orders o USING neuton_legacy_orders legacy WHERE o.id = legacy.id;
DELETE FROM public.audit_logs a USING neuton_legacy_profiles legacy WHERE a.user_id = legacy.id;
DELETE FROM public.document_mutations m USING neuton_legacy_profiles legacy WHERE m.user_id = legacy.id;
DELETE FROM public.inventory_adjustment_batches b USING neuton_legacy_profiles legacy WHERE b.user_id = legacy.id;

-- The existing profile FK cascades legacy membership deletion.
DELETE FROM public.profiles p USING neuton_legacy_profiles legacy WHERE p.id = legacy.id;
--> statement-breakpoint
-- Only enqueue shop-owned object keys that no retained document or upload uses.
WITH removed_paths AS (
  SELECT shop_id, storage_path FROM neuton_legacy_receipts
  UNION ALL
  SELECT shop_id, document_url FROM neuton_legacy_orders
  UNION ALL
  SELECT u.shop_id, p.storage_path
  FROM neuton_legacy_uploads u
  CROSS JOIN LATERAL jsonb_array_elements(u.sources) AS s(source)
  CROSS JOIN LATERAL (VALUES
    (s.source->>'storagePath'),
    ((s.source->>'storagePath') || '.preview-v1.webp'),
    (s.source#>>'{preview,storagePath}')
  ) AS p(storage_path)
), retained_paths AS (
  SELECT shop_id, storage_path FROM public.receipts
  UNION ALL
  SELECT shop_id, storage_path FROM public.recipes
  UNION ALL
  SELECT shop_id, document_url FROM public.orders
  UNION ALL
  SELECT u.shop_id, p.storage_path
  FROM public.media_uploads u
  CROSS JOIN LATERAL jsonb_array_elements(u.sources) AS s(source)
  CROSS JOIN LATERAL (VALUES
    (s.source->>'storagePath'),
    ((s.source->>'storagePath') || '.preview-v1.webp'),
    (s.source#>>'{preview,storagePath}')
  ) AS p(storage_path)
)
INSERT INTO public.storage_object_deletions (shop_id, storage_path, trace_id)
SELECT DISTINCT removed.shop_id, removed.storage_path, 'migration-0034'
FROM removed_paths removed
WHERE left(removed.storage_path, 37) = removed.shop_id::text || '/'
  AND NOT EXISTS (
    SELECT 1 FROM retained_paths retained
    WHERE retained.shop_id = removed.shop_id AND retained.storage_path = removed.storage_path
  )
ON CONFLICT (shop_id, storage_path) DO NOTHING;
--> statement-breakpoint
ALTER TABLE public.shop_members
  DROP CONSTRAINT shop_members_user_id_profiles_id_fk,
  ADD CONSTRAINT shop_members_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.audit_logs
  DROP CONSTRAINT audit_logs_user_id_profiles_id_fk,
  ADD CONSTRAINT audit_logs_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.receipts
  DROP CONSTRAINT receipts_uploaded_by_profiles_id_fk,
  DROP CONSTRAINT receipts_verified_by_fkey,
  ADD CONSTRAINT receipts_uploaded_by_users_id_fk
    FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT receipts_verified_by_users_id_fk
    FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.orders
  DROP CONSTRAINT orders_user_id_profiles_id_fk,
  ADD CONSTRAINT orders_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.media_uploads
  DROP CONSTRAINT media_uploads_uploaded_by_profiles_id_fk,
  ADD CONSTRAINT media_uploads_uploaded_by_users_id_fk
    FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
DROP TABLE public.profiles CASCADE;
