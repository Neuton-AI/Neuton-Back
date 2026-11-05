-- `receipts.raw_extraction` held the raw Gemini JSON blob, but nothing in the app
-- ever read it back: the detail sheet renders the extracted columns, and the
-- extraction-trace endpoint that served it has been removed. Drop the dead
-- column from the schema and the database.
ALTER TABLE "receipts" DROP COLUMN IF EXISTS "raw_extraction";
