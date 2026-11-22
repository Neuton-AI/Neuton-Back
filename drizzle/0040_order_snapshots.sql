-- Preserve unknown historical values: no default and no backfill.
ALTER TABLE orders ADD COLUMN delivery_date date;
--> statement-breakpoint
ALTER TABLE order_items ADD COLUMN cost_complete boolean;
