CREATE TABLE order_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  amount numeric(10, 2) NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT order_payments_kind_check CHECK (kind IN ('deposit', 'payment', 'refund')),
  CONSTRAINT order_payments_positive_amount CHECK (amount > 0 AND amount <> 'NaN'::numeric)
);
--> statement-breakpoint
CREATE INDEX order_payments_order_id_idx ON order_payments (order_id);
--> statement-breakpoint
CREATE UNIQUE INDEX order_payments_one_refund_per_order ON order_payments (order_id) WHERE kind = 'refund';
