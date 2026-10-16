ALTER TABLE "inventory_items" ALTER COLUMN "base_unit_amount" SET DATA TYPE numeric(24, 3);--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "base_unit_average_cost" numeric(18, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD COLUMN "base_unit_cost" numeric(18, 6);
--> statement-breakpoint
-- Existing amounts describe one package; current_quantity counts those packages.
UPDATE "inventory_items"
SET "base_unit_amount" = "base_unit_amount" * GREATEST("current_quantity", 0);
--> statement-breakpoint
-- Historical explicit cost overrides were not persisted and cannot be recovered.
UPDATE "receipt_items" AS item
SET "base_unit_cost" = item."unit_price" / item."base_unit_amount"
FROM "receipts" AS receipt
WHERE receipt."id" = item."receipt_id"
  AND receipt."shop_id" = item."shop_id"
  AND receipt."status" = 'verified'
  AND item."inventory_item_id" IS NOT NULL
  AND item."quantity" > 0
  AND item."base_unit_amount" > 0
  AND item."unit_price" IS NOT NULL;
--> statement-breakpoint
WITH ranked_costs AS (
  SELECT item."inventory_item_id", item."base_unit_cost",
    ROW_NUMBER() OVER (
      PARTITION BY item."inventory_item_id"
      ORDER BY receipt."verified_at" DESC, receipt."id" DESC, item."id" DESC
    ) AS purchase_rank
  FROM "receipt_items" AS item
  JOIN "receipts" AS receipt ON receipt."id" = item."receipt_id" AND receipt."shop_id" = item."shop_id"
  JOIN "inventory_items" AS inventory ON inventory."id" = item."inventory_item_id" AND inventory."shop_id" = item."shop_id"
  WHERE receipt."status" = 'verified'
    AND item."base_unit" = inventory."base_unit"
    AND item."base_unit_cost" IS NOT NULL
    AND item."quantity" > 0
    AND item."base_unit_amount" > 0
), averages AS (
  SELECT "inventory_item_id", AVG("base_unit_cost") AS average_cost
  FROM ranked_costs WHERE purchase_rank <= 20
  GROUP BY "inventory_item_id"
)
UPDATE "inventory_items" AS inventory
SET "base_unit_average_cost" = averages.average_cost
FROM averages WHERE inventory."id" = averages."inventory_item_id";
