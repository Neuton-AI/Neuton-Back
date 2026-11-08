ALTER TABLE public.users ADD COLUMN security_version integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE public.user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  secret_digest varchar(64) NOT NULL,
  security_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason varchar(40),
  device_label varchar(120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX user_sessions_secret_digest_unique ON public.user_sessions (secret_digest);
--> statement-breakpoint
CREATE INDEX user_sessions_user_id_idx ON public.user_sessions (user_id);
--> statement-breakpoint
CREATE INDEX user_sessions_effective_expiry_idx
  ON public.user_sessions (least(idle_expires_at, absolute_expires_at, revoked_at));
--> statement-breakpoint
CREATE TABLE public.pre_auth_contexts (
  secret_digest varchar(64) PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX pre_auth_contexts_expires_at_idx ON public.pre_auth_contexts (expires_at);
