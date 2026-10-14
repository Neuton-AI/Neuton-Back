CREATE TABLE "general_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalized_name" text NOT NULL,
	"barcode" text,
	"name" text NOT NULL,
	"manufacturer" text,
	"chain" text NOT NULL,
	"price_ils" numeric(12, 2) NOT NULL,
	"package_quantity" numeric(12, 3),
	"package_unit" text,
	"price_per_base_unit" numeric(12, 4),
	"source_url" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipt_items" RENAME COLUMN "unit" TO "unit_of_measure";--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "last_order_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "general_price_id" uuid;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "search_able_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "recipe_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_number" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "status" text DEFAULT 'processing' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "general_prices_normalized_name_unique" ON "general_prices" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "general_prices_barcode_idx" ON "general_prices" USING btree ("barcode");--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_general_price_id_general_prices_id_fk" FOREIGN KEY ("general_price_id") REFERENCES "public"."general_prices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_shop_id_status_idx" ON "orders" USING btree ("shop_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_shop_id_order_number_unique" ON "orders" USING btree ("shop_id","order_number");--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_price_link_check" CHECK (num_nonnulls("recipe_ingredients"."inventory_item_id", "recipe_ingredients"."general_price_id") <= 1);