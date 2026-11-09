CREATE TABLE public.google_attempts (
  state_digest varchar(64) PRIMARY KEY,
  context_digest varchar(64) REFERENCES public.pre_auth_contexts(secret_digest) ON DELETE CASCADE,
  session_id uuid REFERENCES public.user_sessions(id) ON DELETE CASCADE,
  link_revision integer,
  nonce varchar(43),
  encrypted_verifier text,
  completion_digest varchar(64),
  completion_proof jsonb,
  expires_at timestamptz NOT NULL,
  CONSTRAINT google_attempts_binding_check CHECK (
    (context_digest IS NOT NULL AND session_id IS NULL AND link_revision IS NULL) OR
    (context_digest IS NULL AND session_id IS NOT NULL AND link_revision IS NOT NULL)
  ),
  CONSTRAINT google_attempts_proof_check CHECK (
    (nonce IS NULL) = (encrypted_verifier IS NULL) AND
    (completion_digest IS NULL) = (completion_proof IS NULL) AND
    (completion_digest IS NULL OR encrypted_verifier IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX google_attempts_context_expiry_idx ON public.google_attempts (context_digest, expires_at);
--> statement-breakpoint
CREATE INDEX google_attempts_session_expiry_idx ON public.google_attempts (session_id, expires_at);
--> statement-breakpoint
CREATE INDEX google_attempts_expiry_idx ON public.google_attempts (expires_at, state_digest);
--> statement-breakpoint
CREATE UNIQUE INDEX google_attempts_completion_unique ON public.google_attempts (completion_digest);
--> statement-breakpoint
-- A legacy database can grant access to new public tables to its browser API roles.
ALTER TABLE public.google_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pre_auth_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_attempts, public.pre_auth_contexts, public.user_sessions FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
  LOOP
    EXECUTE format(
      'REVOKE ALL ON public.google_attempts, public.pre_auth_contexts, public.user_sessions FROM %I',
      api_role
    );
  END LOOP;
END $$;
