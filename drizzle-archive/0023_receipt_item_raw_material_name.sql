ALTER TABLE "receipt_items" ADD COLUMN "raw_material_name" text;--> statement-breakpoint
UPDATE "receipt_items" SET "raw_material_name" = "raw_name";--> statement-breakpoint
ALTER TABLE "receipt_items" ALTER COLUMN "raw_material_name" SET NOT NULL;
