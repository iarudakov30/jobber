CREATE TABLE "accounts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"asset" text NOT NULL,
	"kind" text NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "accounts_owner_asset_kind_unique" UNIQUE("owner_type","owner_id","asset","kind"),
	CONSTRAINT "accounts_id_asset_unique" UNIQUE("id","asset"),
	CONSTRAINT "user_balance_non_negative" CHECK ("accounts"."owner_type" <> 'user' OR "accounts"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"code" text PRIMARY KEY NOT NULL,
	"scale" smallint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" bigint NOT NULL,
	"asset" text NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amount_non_zero" CHECK ("entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"external_ref" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_type_external_ref_unique" UNIQUE("type","external_ref")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_asset_assets_code_fk" FOREIGN KEY ("asset") REFERENCES "public"."assets"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_account_asset_fk" FOREIGN KEY ("account_id","asset") REFERENCES "public"."accounts"("id","asset") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entries_account_id_id_idx" ON "entries" USING btree ("account_id","id");--> statement-breakpoint
CREATE INDEX "entries_transaction_id_idx" ON "entries" USING btree ("transaction_id");