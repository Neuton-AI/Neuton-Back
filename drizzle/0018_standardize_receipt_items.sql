-- Standardize receipt_items to the canonical column set defined in
-- src/db/schema/receipts.ts. Earlier builds carried a measurement/costing model
-- per receipt line (packaging, normalization, application state) that the API
-- never read or wrote; the vision worker only ever produced the extraction
-- columns below. `unit` is renamed to `src_unit` to match the schema.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'receipt_items'
      AND column_name = 'unit'
  ) THEN
    ALTER TABLE "receipt_items" RENAME COLUMN "unit" TO "src_unit";
  END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "receipt_items_shop_id_currency_idx";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "currency";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "review_status";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "code_chain";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "package_quantity";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "package_unit";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "packages_per_purchase";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "measurement_status";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "measurement_reason";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "measurement_evidence";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "normalized_quantity";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "normalized_unit";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "normalized_rate";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "application_status";--> statement-breakpoint
ALTER TABLE "receipt_items" DROP COLUMN IF EXISTS "applied_at";
