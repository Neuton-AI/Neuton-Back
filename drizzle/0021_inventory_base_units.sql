ALTER TABLE "inventory_items" ADD COLUMN "base_unit" text NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "base_unit_amount" numeric(12, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "base_unit_cost" numeric(18, 6) NOT NULL;