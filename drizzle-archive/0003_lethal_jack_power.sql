ALTER TABLE "receipt_items" ADD COLUMN "raw_sku" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "merchant_address" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "receipt_items_shop_id_raw_sku_idx" ON "receipt_items" USING btree ("shop_id","raw_sku") WHERE "receipt_items"."raw_sku" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_shop_id_deleted_at_idx" ON "orders" USING btree ("shop_id","deleted_at");