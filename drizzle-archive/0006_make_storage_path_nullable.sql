ALTER TABLE "receipts" ALTER COLUMN "storage_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_scanned_or_manual_check" CHECK (
    "storage_path" IS NOT NULL
    OR (
        "merchant_name" IS NOT NULL
        AND "receipt_date" IS NOT NULL
        AND "total_amount" IS NOT NULL
        AND "currency" IS NOT NULL
    )
);--> statement-breakpoint
COMMENT ON CONSTRAINT "receipts_scanned_or_manual_check" ON "receipts" IS 'A receipt must be either scanned (has storage_path) or manual (has merchant_name, receipt_date, total_amount, and currency)';
