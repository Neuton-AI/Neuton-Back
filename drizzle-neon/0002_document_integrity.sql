CREATE UNIQUE INDEX "receipts_shop_id_id_unique" ON "receipts" USING btree ("shop_id","id");
CREATE UNIQUE INDEX "orders_shop_id_id_unique" ON "orders" USING btree ("shop_id","id");
CREATE UNIQUE INDEX "media_uploads_shop_id_id_unique" ON "media_uploads" USING btree ("shop_id","id");
ALTER TABLE "app_private"."job_authorizations" DROP CONSTRAINT "job_authorizations_upload_id_media_uploads_id_fk";
--> statement-breakpoint
ALTER TABLE "receipt_items" DROP CONSTRAINT "receipt_items_receipt_id_receipts_id_fk";
--> statement-breakpoint
ALTER TABLE "receipt_items" DROP CONSTRAINT "receipt_items_inventory_item_id_inventory_items_id_fk";
--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_recipe_id_recipes_id_fk";
--> statement-breakpoint
ALTER TABLE "media_uploads" DROP CONSTRAINT "media_uploads_receipt_id_receipts_id_fk";
--> statement-breakpoint
ALTER TABLE "media_uploads" DROP CONSTRAINT "media_uploads_recipe_id_recipes_id_fk";
--> statement-breakpoint
ALTER TABLE "media_uploads" DROP CONSTRAINT "media_uploads_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "app_private"."job_authorizations" ADD CONSTRAINT "job_upload_shop_fk" FOREIGN KEY ("shop_id","upload_id") REFERENCES "public"."media_uploads"("shop_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_receipt_shop_fk" FOREIGN KEY ("shop_id","receipt_id") REFERENCES "public"."receipts"("shop_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_inventory_shop_fk" FOREIGN KEY ("shop_id","inventory_item_id") REFERENCES "public"."inventory_items"("shop_id","id") ON DELETE SET NULL ("inventory_item_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_shop_fk" FOREIGN KEY ("shop_id","order_id") REFERENCES "public"."orders"("shop_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_recipe_shop_fk" FOREIGN KEY ("shop_id","recipe_id") REFERENCES "public"."recipes"("shop_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "uploads_receipt_shop_fk" FOREIGN KEY ("shop_id","receipt_id") REFERENCES "public"."receipts"("shop_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "uploads_recipe_shop_fk" FOREIGN KEY ("shop_id","recipe_id") REFERENCES "public"."recipes"("shop_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "uploads_order_shop_fk" FOREIGN KEY ("shop_id","order_id") REFERENCES "public"."orders"("shop_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_mutations" ADD CONSTRAINT "document_mutations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth_private"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_batches" ADD CONSTRAINT "inventory_adjustment_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth_private"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint

CREATE TRIGGER receipts_immutable BEFORE UPDATE ON public.receipts FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id');
CREATE TRIGGER receipt_items_immutable BEFORE UPDATE ON public.receipt_items FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id');
CREATE TRIGGER orders_immutable BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id');
CREATE TRIGGER order_items_immutable BEFORE UPDATE ON public.order_items FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id');
CREATE TRIGGER media_uploads_immutable BEFORE UPDATE ON public.media_uploads FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id');
CREATE TRIGGER shops_immutable BEFORE UPDATE ON public.shops FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id');
CREATE TRIGGER profiles_immutable BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id');
CREATE TRIGGER shop_members_immutable BEFORE UPDATE ON public.shop_members FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id','user_id');
CREATE TRIGGER document_mutations_immutable BEFORE UPDATE ON public.document_mutations FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id','user_id','request');
CREATE TRIGGER inventory_adjustment_batches_immutable BEFORE UPDATE ON public.inventory_adjustment_batches FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('id','shop_id','user_id','request_hash');
CREATE TRIGGER job_authorizations_immutable BEFORE UPDATE ON app_private.job_authorizations FOR EACH ROW EXECUTE FUNCTION app_private.immutable_columns('job_id','shop_id','requesting_user_id','upload_id','resource_kind','resource_id','operation','sources_digest');
CREATE FUNCTION app_private.immutable_upload_source() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
 OR NEW.recipe_id IS DISTINCT FROM OLD.recipe_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
 OR (NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by AND NOT (NEW.uploaded_by IS NULL AND pg_trigger_depth()>1))
 OR (SELECT jsonb_agg(value-'preview' ORDER BY ord) FROM jsonb_array_elements(NEW.sources) WITH ORDINALITY AS source(value,ord))
 IS DISTINCT FROM (SELECT jsonb_agg(value-'preview' ORDER BY ord) FROM jsonb_array_elements(OLD.sources) WITH ORDINALITY AS source(value,ord)) THEN
  RAISE EXCEPTION 'Immutable upload source association' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.immutable_upload_source() FROM PUBLIC;
CREATE TRIGGER media_uploads_source_immutable BEFORE UPDATE ON public.media_uploads
FOR EACH ROW EXECUTE FUNCTION app_private.immutable_upload_source();
