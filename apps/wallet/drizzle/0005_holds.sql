CREATE TABLE "holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"asset" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holds_amount_positive" CHECK ("holds"."amount" > 0),
	CONSTRAINT "holds_status_valid" CHECK ("holds"."status" IN ('ACTIVE', 'CAPTURED', 'RELEASED'))
);
--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_asset_assets_code_fk" FOREIGN KEY ("asset") REFERENCES "public"."assets"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_trade_user_idx" ON "transactions" USING btree (("metadata" ->> 'userId'),"created_at") WHERE "transactions"."type" = 'trade';