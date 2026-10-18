DROP INDEX "recipe_ingredients_recipe_id_inventory_item_id_unique";--> statement-breakpoint
DROP INDEX "recipe_ingredients_recipe_id_raw_name_unique";--> statement-breakpoint
CREATE INDEX "recipe_ingredients_recipe_id_idx" ON "recipe_ingredients" USING btree ("recipe_id");