CREATE TABLE "idempotency_keys" (
	"scope" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"response" jsonb,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"request_key" text,
	"coin" text NOT NULL,
	"side" text NOT NULL,
	"type" text NOT NULL,
	"qty" bigint NOT NULL,
	"limit_price" bigint,
	"fill_price" bigint,
	"usd_amount" bigint NOT NULL,
	"fee" bigint NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"transaction_id" text,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_side_valid" CHECK ("orders"."side" IN ('BUY', 'SELL')),
	CONSTRAINT "orders_type_valid" CHECK ("orders"."type" IN ('MARKET', 'LIMIT')),
	CONSTRAINT "orders_status_valid" CHECK ("orders"."status" IN ('PLACING', 'OPEN', 'SETTLING', 'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED')),
	CONSTRAINT "orders_qty_positive" CHECK ("orders"."qty" > 0),
	CONSTRAINT "orders_amounts_valid" CHECK ("orders"."usd_amount" > 0 AND "orders"."fee" >= 0 AND "orders"."fee" <= "orders"."usd_amount"),
	CONSTRAINT "orders_limit_price_valid" CHECK (("orders"."type" = 'LIMIT') = ("orders"."limit_price" IS NOT NULL) AND ("orders"."limit_price" IS NULL OR "orders"."limit_price" > 0))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"transport" text NOT NULL,
	"destination" text NOT NULL,
	"key" text,
	"payload" jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "orders_status_coin_idx" ON "orders" USING btree ("status","coin");--> statement-breakpoint
CREATE INDEX "orders_user_created_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_user_request_key_idx" ON "orders" USING btree ("user_id","request_key");--> statement-breakpoint
CREATE INDEX "outbox_published_at_id_idx" ON "outbox" USING btree ("published_at","id");