ALTER TABLE public.users
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD COLUMN google_link_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE public.google_identities (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  CONSTRAINT google_identities_canonical_issuer CHECK (issuer = 'https://accounts.google.com')
);
--> statement-breakpoint
CREATE UNIQUE INDEX google_identities_issuer_subject_unique ON public.google_identities (issuer, subject);
--> statement-breakpoint
-- Protect identities in the same transaction that creates the table.
ALTER TABLE public.google_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_identities FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
  LOOP
    EXECUTE format('REVOKE ALL ON public.google_identities FROM %I', api_role);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE public.user_sessions
  ADD COLUMN sign_in_method text NOT NULL DEFAULT 'password',
  ADD CONSTRAINT user_sessions_sign_in_method_check CHECK (sign_in_method IN ('password', 'google'));
