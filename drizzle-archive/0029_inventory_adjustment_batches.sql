CREATE TABLE inventory_adjustment_batches (
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  PRIMARY KEY (shop_id, id)
);
--> statement-breakpoint
ALTER TABLE inventory_adjustment_batches ENABLE ROW LEVEL SECURITY;
