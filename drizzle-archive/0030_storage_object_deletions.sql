CREATE TABLE storage_object_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  storage_path text NOT NULL,
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (left(storage_path, 37) = shop_id::text || '/')
);
--> statement-breakpoint
CREATE UNIQUE INDEX storage_object_deletions_shop_path_unique ON storage_object_deletions(shop_id,storage_path);
--> statement-breakpoint
CREATE INDEX storage_object_deletions_due_idx ON storage_object_deletions(next_attempt_at,created_at);
--> statement-breakpoint
ALTER TABLE storage_object_deletions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON storage_object_deletions FROM anon, authenticated;
