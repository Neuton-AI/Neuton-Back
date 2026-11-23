ALTER TABLE orders
  ADD COLUMN cancellation_made_items boolean,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX order_items_stock_source_unique ON order_items (id, shop_id, recipe_id);
--> statement-breakpoint
CREATE TABLE finished_stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
  source_order_item_id uuid NOT NULL,
  quantity_added integer NOT NULL,
  quantity_remaining integer NOT NULL,
  unit_cost numeric(10, 2) NOT NULL,
  cost_complete boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finished_stock_source_line_fk FOREIGN KEY (source_order_item_id, shop_id, recipe_id)
    REFERENCES order_items (id, shop_id, recipe_id) ON DELETE RESTRICT,
  CONSTRAINT finished_stock_quantities_check CHECK (
    quantity_added > 0 AND quantity_remaining BETWEEN 0 AND quantity_added
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX finished_stock_source_line_unique ON finished_stock (source_order_item_id);
--> statement-breakpoint
CREATE INDEX finished_stock_shop_id_idx ON finished_stock (shop_id);
--> statement-breakpoint
-- Legacy lines have independent order and recipe foreign keys. Check their
-- ownership before accepting stock without rewriting any historical line.
CREATE FUNCTION check_finished_stock_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM order_items line
    JOIN orders source_order ON source_order.id = line.order_id AND source_order.shop_id = NEW.shop_id
    JOIN recipes source_recipe ON source_recipe.id = line.recipe_id AND source_recipe.shop_id = NEW.shop_id
    WHERE line.id = NEW.source_order_item_id AND line.shop_id = NEW.shop_id AND line.recipe_id = NEW.recipe_id
  ) THEN
    RAISE foreign_key_violation USING MESSAGE = 'Finished stock must match the source order and recipe shop';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER finished_stock_ownership
BEFORE INSERT OR UPDATE OF source_order_item_id, shop_id, recipe_id ON finished_stock
FOR EACH ROW EXECUTE FUNCTION check_finished_stock_ownership();
