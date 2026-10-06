ALTER TABLE "receipts" ADD COLUMN "verified_by" uuid REFERENCES "profiles" ("id") ON DELETE SET NULL;
ALTER TABLE "receipts" ADD COLUMN "verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "receipt_items" ADD COLUMN "review_status" text DEFAULT 'pending' NOT NULL;