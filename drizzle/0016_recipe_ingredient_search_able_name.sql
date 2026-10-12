ALTER TABLE "recipe_ingredients" ADD COLUMN "search_able_name" text;--> statement-breakpoint
UPDATE "recipe_ingredients" SET "search_able_name" = "raw_name" WHERE "search_able_name" IS NULL;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ALTER COLUMN "search_able_name" SET NOT NULL;
