-- B/84: recipes carry the failure reason so the UI can distinguish "no recipes"
-- from "your recipe failed to upload, and why". Mirrors receipts.error_message.
ALTER TABLE "recipes" ADD COLUMN "error_message" text;