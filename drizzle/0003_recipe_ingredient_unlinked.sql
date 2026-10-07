ALTER TABLE "receipts" ALTER COLUMN "storage_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "storage_path" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD COLUMN "review_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "progress_stage" text DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "progress_message" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "processing_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "verified_by" uuid;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_verified_by_profiles_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipes_shop_id_status_idx" ON "recipes" USING btree ("shop_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_shop_id_storage_path_unique" ON "recipes" USING btree ("shop_id","storage_path") WHERE "recipes"."storage_path" IS NOT NULL;