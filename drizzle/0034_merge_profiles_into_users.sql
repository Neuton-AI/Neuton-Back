ALTER TABLE public.users
  ADD COLUMN full_name text,
  ADD COLUMN avatar_url text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
LOCK TABLE public.profiles IN ACCESS EXCLUSIVE MODE;

UPDATE public.users u
SET full_name = p.full_name,
    avatar_url = p.avatar_url,
    created_at = p.created_at,
    updated_at = p.updated_at
FROM public.profiles p
WHERE p.id = u.id;

-- The old FKs remove legacy memberships and clear nullable actor references.
DELETE FROM public.profiles p
WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p.id);
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
DROP TABLE public.profiles;
