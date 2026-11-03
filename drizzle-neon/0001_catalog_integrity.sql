CREATE UNIQUE INDEX "categories_shop_id_id_unique" ON "categories" USING btree ("shop_id","id");
CREATE UNIQUE INDEX "inventory_items_shop_id_id_unique" ON "inventory_items" USING btree ("shop_id","id");
CREATE UNIQUE INDEX "recipes_shop_id_id_unique" ON "recipes" USING btree ("shop_id","id");
ALTER TABLE "inventory_items" DROP CONSTRAINT "inventory_items_category_id_categories_id_fk";
--> statement-breakpoint
ALTER TABLE "recipe_ingredients" DROP CONSTRAINT "recipe_ingredients_recipe_id_recipes_id_fk";
--> statement-breakpoint
ALTER TABLE "recipe_ingredients" DROP CONSTRAINT "recipe_ingredients_inventory_item_id_inventory_items_id_fk";
--> statement-breakpoint
ALTER TABLE "recipes" DROP CONSTRAINT "recipes_category_id_categories_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_category_shop_fk" FOREIGN KEY ("shop_id","category_id") REFERENCES "public"."categories"("shop_id","id") ON DELETE SET NULL ("category_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "ingredients_recipe_shop_fk" FOREIGN KEY ("shop_id","recipe_id") REFERENCES "public"."recipes"("shop_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "ingredients_inventory_shop_fk" FOREIGN KEY ("shop_id","inventory_item_id") REFERENCES "public"."inventory_items"("shop_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_category_shop_fk" FOREIGN KEY ("shop_id","category_id") REFERENCES "public"."categories"("shop_id","id") ON DELETE SET NULL ("category_id") ON UPDATE no action;--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint

CREATE FUNCTION app_private.immutable_columns() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE field text;
BEGIN
 FOREACH field IN ARRAY TG_ARGV LOOP
  IF to_jsonb(NEW)->field IS DISTINCT FROM to_jsonb(OLD)->field THEN
   RAISE EXCEPTION 'Immutable row identity' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.immutable_columns() FROM PUBLIC;
CREATE TRIGGER categories_immutable BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id');
CREATE TRIGGER inventory_items_immutable BEFORE UPDATE ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id');
CREATE TRIGGER recipes_immutable BEFORE UPDATE ON public.recipes FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id');
CREATE TRIGGER recipe_ingredients_immutable BEFORE UPDATE ON public.recipe_ingredients FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id');
CREATE TRIGGER product_measurements_immutable BEFORE UPDATE ON public.product_measurements FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id');
CREATE TRIGGER ingredient_conversions_immutable BEFORE UPDATE ON public.ingredient_conversions FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id');
