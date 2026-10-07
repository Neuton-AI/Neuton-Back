ALTER TABLE "recipe_ingredients" ALTER COLUMN "inventory_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "raw_name" text NOT NULL;