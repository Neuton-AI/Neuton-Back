CREATE TABLE "media_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"uploaded_by" uuid,
	"kind" text NOT NULL,
	"sources" jsonb NOT NULL,
	"receipt_id" uuid,
	"recipe_id" uuid,
	"order_id" uuid,
	"queued_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_uploads_source_count" CHECK (jsonb_array_length("media_uploads"."sources") BETWEEN 1 AND 4)
);
--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_uploaded_by_profiles_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_uploads_shop_id_idx" ON "media_uploads" USING btree ("shop_id");
--> statement-breakpoint
ALTER TABLE "media_uploads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "media_uploads_shop_read" ON "media_uploads" FOR SELECT TO authenticated
USING (public.is_shop_member(shop_id));
--> statement-breakpoint
-- Only the API may create/change a group or its immutable source associations.
REVOKE ALL ON "media_uploads" FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON "media_uploads" TO authenticated;
