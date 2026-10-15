ALTER TABLE "orders" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "orders_shop_id_deleted_at_idx" ON "orders" USING btree ("shop_id","deleted_at");