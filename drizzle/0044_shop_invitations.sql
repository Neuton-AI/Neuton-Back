CREATE TABLE shop_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offered_role text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  resolved_at timestamptz,
  CONSTRAINT shop_invitations_offered_role CHECK (offered_role IN ('member', 'admin')),
  CONSTRAINT shop_invitations_status CHECK (status IN ('pending', 'accepted', 'declined', 'canceled')),
  CONSTRAINT shop_invitations_resolution CHECK ((status = 'pending') = (resolved_at IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX shop_invitations_pending_unique ON shop_invitations(shop_id, recipient_id) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX shop_invitations_shop_id_idx ON shop_invitations(shop_id);
--> statement-breakpoint
CREATE INDEX shop_invitations_recipient_id_idx ON shop_invitations(recipient_id);
--> statement-breakpoint
ALTER TABLE shop_invitations ENABLE ROW LEVEL SECURITY;
