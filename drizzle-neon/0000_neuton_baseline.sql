-- Fresh Neuton baseline. Apply only through the guarded migration runner.
CREATE SCHEMA IF NOT EXISTS app_private;
CREATE SCHEMA "auth_private";
--> statement-breakpoint
CREATE TABLE "ingredient_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"profile" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_private"."job_authorizations" (
	"job_id" varchar(200) PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"requesting_user_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"sources_digest" varchar(64) NOT NULL,
	"state" text DEFAULT 'accepted' NOT NULL,
	"correlation_id" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" varchar(80),
	CONSTRAINT "job_authorizations_identity_check" CHECK ("app_private"."job_authorizations"."job_id" = 'upload-' || "app_private"."job_authorizations"."upload_id"::text),
	CONSTRAINT "job_authorizations_sources_check" CHECK ("app_private"."job_authorizations"."sources_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "job_authorizations_operation_check" CHECK (
    ("app_private"."job_authorizations"."operation" = 'extract_receipt' and "app_private"."job_authorizations"."resource_kind" = 'receipt') or
    ("app_private"."job_authorizations"."operation" = 'extract_recipe' and "app_private"."job_authorizations"."resource_kind" = 'recipe') or
    ("app_private"."job_authorizations"."operation" = 'extract_order' and "app_private"."job_authorizations"."resource_kind" = 'order') or
    ("app_private"."job_authorizations"."operation" = 'extract_product' and "app_private"."job_authorizations"."resource_kind" = 'upload' and "app_private"."job_authorizations"."resource_id" = "app_private"."job_authorizations"."upload_id")),
	CONSTRAINT "job_authorizations_state_check" CHECK ("app_private"."job_authorizations"."state" in ('accepted','queued','processing','completed','failed','cancelled')),
	CONSTRAINT "job_authorizations_cancellation_check" CHECK ("app_private"."job_authorizations"."state" <> 'cancelled' or "app_private"."job_authorizations"."cancelled_at" is not null),
	CONSTRAINT "job_authorizations_lifetime_check" CHECK ("app_private"."job_authorizations"."created_at" < "app_private"."job_authorizations"."expires_at")
);
--> statement-breakpoint
CREATE TABLE "product_measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"product_key" text NOT NULL,
	"package_quantity" numeric(20, 6) NOT NULL,
	"package_unit" text NOT NULL,
	"packages_per_purchase" numeric(20, 6) DEFAULT '1' NOT NULL,
	"evidence" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"user_id" uuid,
	"ip_address" varchar(45),
	"event_type" text NOT NULL,
	"resource_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_members_role_check" CHECK ("shop_members"."role" in ('owner','admin','member'))
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"last_order_number" integer DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"store_address" text,
	"target_profit_margin" numeric(5, 2) DEFAULT '0.00' NOT NULL,
	"hourly_labor_cost" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"delivery_base_fee" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"delivery_rate_per_km" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "general_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_name" text NOT NULL,
	"sku" text,
	"raw_material_name" text NOT NULL,
	"raw_src_unit" text,
	"src_unit" text,
	"base_unit" text,
	"base_unit_amount" numeric(24, 3),
	"base_unit_cost" numeric(18, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"category_id" uuid,
	"name" text NOT NULL,
	"raw_material_name" text NOT NULL,
	"sku" text,
	"image_url" text,
	"unit" text NOT NULL,
	"base_unit" text NOT NULL,
	"base_unit_amount" numeric(24, 3) NOT NULL,
	"base_unit_cost" numeric(18, 6) NOT NULL,
	"base_unit_average_cost" numeric(18, 6) DEFAULT '0' NOT NULL,
	"current_quantity" numeric(12, 3) DEFAULT '0' NOT NULL,
	"reorder_level" numeric(12, 3),
	"last_unit_cost" numeric(12, 4),
	"average_unit_cost" numeric(12, 4),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"inventory_item_id" uuid,
	"general_price_id" uuid,
	"raw_name" text NOT NULL,
	"raw_material_name" text NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"raw_src_unit" text NOT NULL,
	"base_unit" text,
	"base_unit_amount" numeric(24, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_ingredients_price_link_check" CHECK (num_nonnulls("recipe_ingredients"."inventory_item_id", "recipe_ingredients"."general_price_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"category_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"prep_time_minutes" integer DEFAULT 0 NOT NULL,
	"yield_quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"yield_unit" text DEFAULT 'portion' NOT NULL,
	"target_margin_pct" numeric(5, 2),
	"allergens" text[],
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_path" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipt_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"inventory_item_id" uuid,
	"raw_name" text NOT NULL,
	"raw_material_name" text NOT NULL,
	"raw_sku" text,
	"quantity" numeric(12, 3),
	"unit_price" numeric(12, 4),
	"total_price" numeric(12, 2),
	"raw_src_unit" text,
	"src_unit" text,
	"src_unit_amount" numeric(12, 3),
	"base_unit" text,
	"base_unit_amount" numeric(12, 3),
	"base_unit_cost" numeric(18, 6),
	"confidence" numeric(4, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"uploaded_by" uuid,
	"storage_path" text,
	"content_type" text,
	"original_filename" text,
	"merchant_name" text,
	"merchant_address" text,
	"receipt_date" date,
	"payment_method" text,
	"total_amount" numeric(12, 2),
	"tax_amount" numeric(12, 2),
	"currency" char(3),
	"status" text DEFAULT 'pending' NOT NULL,
	"progress_stage" text DEFAULT 'pending',
	"progress_message" text,
	"processing_started_at" timestamp with time zone,
	"processing_deadline" timestamp with time zone,
	"error_message" text,
	"processed_at" timestamp with time zone,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"recipe_name" text,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit_cost" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"unit_price" numeric(10, 2) DEFAULT '0.00' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" integer NOT NULL,
	"shop_id" uuid NOT NULL,
	"user_id" uuid,
	"customer_name" text,
	"order_date" timestamp with time zone DEFAULT now() NOT NULL,
	"destination_address" text,
	"delivery_distance_km" numeric(8, 2) DEFAULT '0.00' NOT NULL,
	"delivery_fee" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"applied_profit_margin" numeric(5, 2),
	"total_cost" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"total_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"document_url" text,
	"status" text DEFAULT 'processing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
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
CREATE TABLE "document_mutations" (
	"shop_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"status" integer DEFAULT 200 NOT NULL,
	CONSTRAINT "document_mutations_shop_id_id_pk" PRIMARY KEY("shop_id","id")
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"shop_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"id" uuid NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "document_versions_shop_id_kind_id_pk" PRIMARY KEY("shop_id","kind","id")
);
--> statement-breakpoint
CREATE TABLE "inventory_adjustment_batches" (
	"shop_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	CONSTRAINT "inventory_adjustment_batches_shop_id_id_pk" PRIMARY KEY("shop_id","id")
);
--> statement-breakpoint
CREATE TABLE "storage_object_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	CONSTRAINT "storage_object_deletions_attempts_check" CHECK ("storage_object_deletions"."attempts" >= 0),
	CONSTRAINT "storage_object_deletions_lease_check" CHECK (("storage_object_deletions"."lease_token" is null) = ("storage_object_deletions"."lease_until" is null)),
	CONSTRAINT "storage_object_deletions_tenant_path" CHECK (left("storage_object_deletions"."storage_path", 37) = "storage_object_deletions"."shop_id"::text || '/')
);
--> statement-breakpoint
CREATE TABLE "auth_private"."action_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_digest" varchar(64) NOT NULL,
	"intended_email" varchar(320),
	"security_version" integer NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "action_tokens_purpose_check" CHECK ("auth_private"."action_tokens"."purpose" in ('confirm_email','password_reset','email_change')),
	CONSTRAINT "action_tokens_version_check" CHECK ("auth_private"."action_tokens"."security_version" >= 1),
	CONSTRAINT "action_tokens_digest_check" CHECK ("auth_private"."action_tokens"."token_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "action_tokens_email_check" CHECK ("auth_private"."action_tokens"."purpose" = 'password_reset' or "auth_private"."action_tokens"."intended_email" is not null),
	CONSTRAINT "action_tokens_lifetime_check" CHECK ("auth_private"."action_tokens"."issued_at" < "auth_private"."action_tokens"."expires_at")
);
--> statement-breakpoint
CREATE TABLE "auth_private"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_digest" varchar(64) NOT NULL,
	"security_version" integer NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"authentication_method" text NOT NULL,
	"recent_authenticated_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" varchar(80),
	"csrf_digest" varchar(64) NOT NULL,
	"user_agent" varchar(256),
	"ip_address" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_security_version_check" CHECK ("auth_private"."sessions"."security_version" >= 1),
	CONSTRAINT "sessions_digests_check" CHECK ("auth_private"."sessions"."token_digest" ~ '^[a-f0-9]{64}$' and "auth_private"."sessions"."csrf_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "sessions_method_check" CHECK ("auth_private"."sessions"."authentication_method" in ('password','google')),
	CONSTRAINT "sessions_lifetime_check" CHECK ("auth_private"."sessions"."authenticated_at" <= "auth_private"."sessions"."last_activity_at" and "auth_private"."sessions"."last_activity_at" < "auth_private"."sessions"."idle_expires_at" and "auth_private"."sessions"."idle_expires_at" <= "auth_private"."sessions"."absolute_expires_at")
);
--> statement-breakpoint
CREATE TABLE "auth_private"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"normalized_email" varchar(320) NOT NULL,
	"email_confirmed_at" timestamp with time zone,
	"status" text DEFAULT 'pending_email' NOT NULL,
	"security_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_status_check" CHECK ("auth_private"."users"."status" in ('pending_email','active','disabled')),
	CONSTRAINT "users_security_version_check" CHECK ("auth_private"."users"."security_version" >= 1),
	CONSTRAINT "users_active_confirmed_check" CHECK ("auth_private"."users"."status" <> 'active' or "auth_private"."users"."email_confirmed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "auth_private"."browser_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_digest" varchar(64) NOT NULL,
	"csrf_digest" varchar(64) NOT NULL,
	"environment" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "browser_contexts_digests_check" CHECK ("auth_private"."browser_contexts"."token_digest" ~ '^[a-f0-9]{64}$' and "auth_private"."browser_contexts"."csrf_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "browser_contexts_lifetime_check" CHECK ("auth_private"."browser_contexts"."created_at" < "auth_private"."browser_contexts"."expires_at")
);
--> statement-breakpoint
CREATE TABLE "auth_private"."google_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"subject" varchar(255) NOT NULL,
	"observed_email" varchar(320),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "google_identities_issuer_check" CHECK ("auth_private"."google_identities"."issuer" = 'https://accounts.google.com'),
	CONSTRAINT "google_identities_subject_check" CHECK (length("auth_private"."google_identities"."subject") > 0)
);
--> statement-breakpoint
CREATE TABLE "auth_private"."mail_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"destination" varchar(320) NOT NULL,
	"encrypted_payload" text,
	"payload_key_id" varchar(64),
	"action_token_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	CONSTRAINT "mail_outbox_purpose_check" CHECK ("auth_private"."mail_outbox"."purpose" in ('confirm_email','password_reset','email_change','security_notice')),
	CONSTRAINT "mail_outbox_action_check" CHECK ("auth_private"."mail_outbox"."purpose" = 'security_notice' or "auth_private"."mail_outbox"."action_token_id" is not null),
	CONSTRAINT "mail_outbox_attempts_check" CHECK ("auth_private"."mail_outbox"."attempts" >= 0),
	CONSTRAINT "mail_outbox_lease_check" CHECK (("auth_private"."mail_outbox"."lease_token" is null) = ("auth_private"."mail_outbox"."lease_until" is null)),
	CONSTRAINT "mail_outbox_encryption_check" CHECK (("auth_private"."mail_outbox"."encrypted_payload" is null) = ("auth_private"."mail_outbox"."payload_key_id" is null)),
	CONSTRAINT "mail_outbox_pending_payload_check" CHECK ("auth_private"."mail_outbox"."sent_at" is not null or "auth_private"."mail_outbox"."discarded_at" is not null or "auth_private"."mail_outbox"."encrypted_payload" is not null),
	CONSTRAINT "mail_outbox_lifetime_check" CHECK ("auth_private"."mail_outbox"."created_at" < "auth_private"."mail_outbox"."expires_at")
);
--> statement-breakpoint
CREATE TABLE "auth_private"."oauth_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_digest" varchar(64) NOT NULL,
	"transaction_id" uuid NOT NULL,
	"target_user_id" uuid,
	"candidate_user_id" uuid,
	"identity" jsonb NOT NULL,
	"expected_security_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_completions_digest_check" CHECK ("auth_private"."oauth_completions"."ticket_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "oauth_completions_target_check" CHECK (num_nonnulls("auth_private"."oauth_completions"."target_user_id","auth_private"."oauth_completions"."candidate_user_id") = 1),
	CONSTRAINT "oauth_completions_version_check" CHECK ("auth_private"."oauth_completions"."expected_security_version" >= 1),
	CONSTRAINT "oauth_completions_identity_check" CHECK (jsonb_typeof("auth_private"."oauth_completions"."identity") = 'object' and octet_length("auth_private"."oauth_completions"."identity"::text) <= 4096),
	CONSTRAINT "oauth_completions_identity_fields_check" CHECK ("auth_private"."oauth_completions"."identity" ?& array['issuer','subject'] and "auth_private"."oauth_completions"."identity"->>'issuer' = 'https://accounts.google.com' and length("auth_private"."oauth_completions"."identity"->>'subject') > 0 and ("auth_private"."oauth_completions"."identity" - array['issuer','subject','observedEmail','emailVerified','displayName','avatarUrl','authenticatedAt']::text[]) = '{}'::jsonb),
	CONSTRAINT "oauth_completions_lifetime_check" CHECK ("auth_private"."oauth_completions"."created_at" < "auth_private"."oauth_completions"."expires_at")
);
--> statement-breakpoint
CREATE TABLE "auth_private"."oauth_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_digest" varchar(64) NOT NULL,
	"browser_context_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"initiating_user_id" uuid,
	"initiating_session_id" uuid,
	"expected_security_version" integer,
	"nonce" varchar(128) NOT NULL,
	"encrypted_verifier" text,
	"verifier_key_id" varchar(64),
	"return_path" varchar(256) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "oauth_transactions_digest_check" CHECK ("auth_private"."oauth_transactions"."state_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "oauth_transactions_purpose_check" CHECK ("auth_private"."oauth_transactions"."purpose" in ('login','link','reauthenticate')),
	CONSTRAINT "oauth_transactions_status_check" CHECK ("auth_private"."oauth_transactions"."status" in ('pending','claimed','completed','failed')),
	CONSTRAINT "oauth_transactions_initiator_check" CHECK (("auth_private"."oauth_transactions"."purpose" = 'login' and "auth_private"."oauth_transactions"."initiating_user_id" is null and "auth_private"."oauth_transactions"."initiating_session_id" is null and "auth_private"."oauth_transactions"."expected_security_version" is null) or ("auth_private"."oauth_transactions"."purpose" <> 'login' and "auth_private"."oauth_transactions"."initiating_user_id" is not null and "auth_private"."oauth_transactions"."initiating_session_id" is not null and "auth_private"."oauth_transactions"."expected_security_version" is not null and "auth_private"."oauth_transactions"."expected_security_version" >= 1)),
	CONSTRAINT "oauth_transactions_encryption_check" CHECK (("auth_private"."oauth_transactions"."encrypted_verifier" is null) = ("auth_private"."oauth_transactions"."verifier_key_id" is null)),
	CONSTRAINT "oauth_transactions_lifetime_check" CHECK ("auth_private"."oauth_transactions"."created_at" < "auth_private"."oauth_transactions"."expires_at")
);
--> statement-breakpoint
CREATE TABLE "auth_private"."password_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"encoded_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_private"."security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"subject_user_id" uuid,
	"session_id" uuid,
	"event" varchar(80) NOT NULL,
	"result" text NOT NULL,
	"correlation_id" varchar(128) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_events_result_check" CHECK ("auth_private"."security_events"."result" in ('success','denied','failed')),
	CONSTRAINT "security_events_metadata_check" CHECK (jsonb_typeof("auth_private"."security_events"."metadata") = 'object' and octet_length("auth_private"."security_events"."metadata"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "ingredient_conversions" ADD CONSTRAINT "ingredient_conversions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."job_authorizations" ADD CONSTRAINT "job_authorizations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."job_authorizations" ADD CONSTRAINT "job_authorizations_requesting_user_id_users_id_fk" FOREIGN KEY ("requesting_user_id") REFERENCES "auth_private"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."job_authorizations" ADD CONSTRAINT "job_authorizations_upload_id_media_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_measurements" ADD CONSTRAINT "product_measurements_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "auth_private"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_members" ADD CONSTRAINT "shop_members_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_members" ADD CONSTRAINT "shop_members_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_general_price_id_general_prices_id_fk" FOREIGN KEY ("general_price_id") REFERENCES "public"."general_prices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_uploaded_by_profiles_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_verified_by_profiles_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_uploaded_by_profiles_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_mutations" ADD CONSTRAINT "document_mutations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_batches" ADD CONSTRAINT "inventory_adjustment_batches_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_private"."action_tokens" ADD CONSTRAINT "action_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth_private"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_private"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth_private"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_private"."google_identities" ADD CONSTRAINT "google_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth_private"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_private"."mail_outbox" ADD CONSTRAINT "mail_outbox_action_token_id_action_tokens_id_fk" FOREIGN KEY ("action_token_id") REFERENCES "auth_private"."action_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_private"."oauth_completions" ADD CONSTRAINT "oauth_completions_transaction_id_oauth_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "auth_private"."oauth_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_private"."oauth_completions" ADD CONSTRAINT "oauth_completions_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "auth_private"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_private"."oauth_transactions" ADD CONSTRAINT "oauth_transactions_browser_context_id_browser_contexts_id_fk" FOREIGN KEY ("browser_context_id") REFERENCES "auth_private"."browser_contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_private"."oauth_transactions" ADD CONSTRAINT "oauth_transactions_initiating_user_id_users_id_fk" FOREIGN KEY ("initiating_user_id") REFERENCES "auth_private"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_private"."oauth_transactions" ADD CONSTRAINT "oauth_transactions_initiating_session_id_sessions_id_fk" FOREIGN KEY ("initiating_session_id") REFERENCES "auth_private"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_private"."password_credentials" ADD CONSTRAINT "password_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth_private"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_private"."security_events" ADD CONSTRAINT "security_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth_private"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_private"."security_events" ADD CONSTRAINT "security_events_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "auth_private"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_private"."security_events" ADD CONSTRAINT "security_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "auth_private"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingredient_conversions_shop_scope_unique" ON "ingredient_conversions" USING btree ("shop_id","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "job_authorizations_upload_unique" ON "app_private"."job_authorizations" USING btree ("upload_id");--> statement-breakpoint
CREATE INDEX "job_authorizations_resource_idx" ON "app_private"."job_authorizations" USING btree ("shop_id","resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "job_authorizations_expiry_idx" ON "app_private"."job_authorizations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "job_authorizations_publication_idx" ON "app_private"."job_authorizations" USING btree ("created_at") WHERE "app_private"."job_authorizations"."state" = 'accepted';--> statement-breakpoint
CREATE UNIQUE INDEX "product_measurements_shop_product_unique" ON "product_measurements" USING btree ("shop_id","product_key");--> statement-breakpoint
CREATE INDEX "audit_logs_shop_id_created_at_idx" ON "audit_logs" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_members_shop_id_user_id_unique" ON "shop_members" USING btree ("shop_id","user_id");--> statement-breakpoint
CREATE INDEX "shop_members_user_id_idx" ON "shop_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shops_slug_unique" ON "shops" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_shop_id_name_unique" ON "categories" USING btree ("shop_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "general_prices_material_sku_unique" ON "general_prices" USING btree ("raw_material_name","sku");--> statement-breakpoint
CREATE INDEX "general_prices_sku_idx" ON "general_prices" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_shop_id_name_unique" ON "inventory_items" USING btree ("shop_id","name");--> statement-breakpoint
CREATE INDEX "inventory_items_shop_id_sku_idx" ON "inventory_items" USING btree ("shop_id","sku") WHERE "inventory_items"."sku" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "recipe_ingredients_recipe_id_idx" ON "recipe_ingredients" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "recipe_ingredients_shop_id_idx" ON "recipe_ingredients" USING btree ("shop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_shop_id_name_unique" ON "recipes" USING btree ("shop_id","name");--> statement-breakpoint
CREATE INDEX "recipes_shop_id_idx" ON "recipes" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "recipes_shop_id_status_idx" ON "recipes" USING btree ("shop_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_shop_id_storage_path_unique" ON "recipes" USING btree ("shop_id","storage_path") WHERE "recipes"."storage_path" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "receipt_items_receipt_id_idx" ON "receipt_items" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "receipt_items_shop_id_inventory_item_id_idx" ON "receipt_items" USING btree ("shop_id","inventory_item_id");--> statement-breakpoint
CREATE INDEX "receipt_items_shop_id_raw_sku_idx" ON "receipt_items" USING btree ("shop_id","raw_sku") WHERE "receipt_items"."raw_sku" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "receipts_shop_id_receipt_date_idx" ON "receipts" USING btree ("shop_id","receipt_date");--> statement-breakpoint
CREATE INDEX "receipts_shop_id_status_idx" ON "receipts" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "order_items_order_id_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_shop_id_order_date_idx" ON "orders" USING btree ("shop_id","order_date");--> statement-breakpoint
CREATE INDEX "orders_shop_id_deleted_at_idx" ON "orders" USING btree ("shop_id","deleted_at");--> statement-breakpoint
CREATE INDEX "orders_shop_id_status_idx" ON "orders" USING btree ("shop_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_shop_id_order_number_unique" ON "orders" USING btree ("shop_id","order_number");--> statement-breakpoint
CREATE INDEX "media_uploads_shop_id_idx" ON "media_uploads" USING btree ("shop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_object_deletions_shop_path_unique" ON "storage_object_deletions" USING btree ("shop_id","storage_path");--> statement-breakpoint
CREATE INDEX "storage_object_deletions_due_idx" ON "storage_object_deletions" USING btree ("next_attempt_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "action_tokens_digest_unique" ON "auth_private"."action_tokens" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "action_tokens_user_purpose_idx" ON "auth_private"."action_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "action_tokens_expiry_idx" ON "auth_private"."action_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_digest_unique" ON "auth_private"."sessions" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "auth_private"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_absolute_expiry_idx" ON "auth_private"."sessions" USING btree ("absolute_expires_at");--> statement-breakpoint
CREATE INDEX "sessions_idle_expiry_idx" ON "auth_private"."sessions" USING btree ("idle_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_normalized_email_unique" ON "auth_private"."users" USING btree ("normalized_email");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_contexts_digest_unique" ON "auth_private"."browser_contexts" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "browser_contexts_expiry_idx" ON "auth_private"."browser_contexts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "google_identities_issuer_subject_unique" ON "auth_private"."google_identities" USING btree ("issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "google_identities_user_unique" ON "auth_private"."google_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mail_outbox_due_idx" ON "auth_private"."mail_outbox" USING btree ("next_attempt_at","created_at") WHERE "auth_private"."mail_outbox"."sent_at" is null and "auth_private"."mail_outbox"."discarded_at" is null;--> statement-breakpoint
CREATE INDEX "mail_outbox_expiry_idx" ON "auth_private"."mail_outbox" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mail_outbox_action_token_idx" ON "auth_private"."mail_outbox" USING btree ("action_token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_completions_ticket_unique" ON "auth_private"."oauth_completions" USING btree ("ticket_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_completions_transaction_unique" ON "auth_private"."oauth_completions" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "oauth_completions_expiry_idx" ON "auth_private"."oauth_completions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_transactions_state_unique" ON "auth_private"."oauth_transactions" USING btree ("state_digest");--> statement-breakpoint
CREATE INDEX "oauth_transactions_browser_idx" ON "auth_private"."oauth_transactions" USING btree ("browser_context_id","created_at");--> statement-breakpoint
CREATE INDEX "oauth_transactions_expiry_idx" ON "auth_private"."oauth_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "security_events_subject_time_idx" ON "auth_private"."security_events" USING btree ("subject_user_id","created_at");--> statement-breakpoint
CREATE INDEX "security_events_created_at_idx" ON "auth_private"."security_events" USING btree ("created_at");
REVOKE ALL ON SCHEMA public, auth_private, app_private FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public, auth_private, app_private FROM PUBLIC, neuton_app, neuton_auth, neuton_worker, neuton_cleanup, neuton_policy_reader, neuton_bootstrap;
ALTER TABLE public.ingredient_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingredient_conversions FORCE ROW LEVEL SECURITY;
ALTER TABLE app_private.job_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.job_authorizations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_measurements FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shop_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_members FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shops FORCE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_ingredients FORCE ROW LEVEL SECURITY;
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.receipt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipt_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;
ALTER TABLE public.media_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_uploads FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_mutations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_adjustment_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_adjustment_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE public.storage_object_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storage_object_deletions FORCE ROW LEVEL SECURITY;
