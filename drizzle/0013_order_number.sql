-- N-105: per-shop sequential order numbers for invoicing compliance.
--
-- Orders carried only a UUID, so an invoice had nothing sequential to print and
-- a hard delete erased the row: no gapless sequence, no way to prove a number
-- was never reused. IL/EU invoicing wants a per-shop sequence where a number is
-- issued once, never reused, and a cancellation keeps its number as a void.
--
-- `shops.last_order_number` is the high-water mark POST /orders increments
-- inside the order's creation transaction, so concurrent creates serialize on
-- the shop row and can neither duplicate nor skip a number. `orders.order_number`
-- has no DEFAULT on purpose: a number that did not come from the counter is a
-- number nobody can audit, so every insert must ask for one.
--
-- Existing rows are backfilled in creation order, one sequence per shop. Rows
-- that were hard-deleted before this migration left holes that no backfill can
-- close — the sequence is gapless from here on, which is the best a live table
-- can do.
ALTER TABLE "shops" ADD COLUMN "last_order_number" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_number" integer;--> statement-breakpoint
WITH ranked AS (
  SELECT "id", row_number() OVER (PARTITION BY "shop_id" ORDER BY "created_at", "id")::int AS "row_number"
  FROM "orders"
)
UPDATE "orders" SET "order_number" = ranked."row_number" FROM ranked WHERE "orders"."id" = ranked."id";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "order_number" SET NOT NULL;--> statement-breakpoint
UPDATE "shops" SET "last_order_number" = highest."row_number"
FROM (SELECT "shop_id", max("order_number") AS "row_number" FROM "orders" GROUP BY "shop_id") AS "highest"
WHERE "shops"."id" = highest."shop_id";--> statement-breakpoint
CREATE UNIQUE INDEX "orders_shop_id_order_number_unique" ON "orders" ("shop_id","order_number");
