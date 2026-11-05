-- N-103: order processing/delivered lifecycle status.
--
-- Orders had no lifecycle state; the UI could neither filter nor display
-- whether an order was still being prepared or already handed over.
-- Every new order starts as 'processing' and moves to 'delivered' only after
-- explicit human verification via PATCH /orders/:id/status.
-- Existing rows predate the workflow and are still in progress, so backfill
-- them to 'processing'; the DEFAULT only applies to newly created orders.
ALTER TABLE "orders" ADD COLUMN "status" text NOT NULL DEFAULT 'processing';
--> statement-breakpoint
UPDATE "orders" SET "status" = 'processing' WHERE "status" IS NULL;
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'processing';
--> statement-breakpoint
CREATE INDEX "orders_shop_id_status_idx" ON "orders" ("shop_id", "status");
