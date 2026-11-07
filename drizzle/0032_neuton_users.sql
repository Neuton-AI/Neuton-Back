CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX users_email_unique ON public.users (email);
--> statement-breakpoint
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.users FROM PUBLIC;
