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
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"stripe_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_stripe_session_id_unique" UNIQUE("stripe_session_id"),
	CONSTRAINT "payments_amount_range" CHECK ("payments"."amount" BETWEEN 100 AND 100000),
	CONSTRAINT "payments_currency" CHECK ("payments"."currency" = 'USD'),
	CONSTRAINT "payments_status" CHECK ("payments"."status" IN ('PENDING', 'SUCCEEDED', 'EXPIRED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "recon_issues" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payment_id" uuid,
	"stripe_event_id" text,
	"stripe_session_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_published_at_id_idx" ON "outbox" USING btree ("published_at","id");--> statement-breakpoint
CREATE INDEX "payments_user_id_created_at_idx" ON "payments" USING btree ("user_id","created_at" DESC NULLS LAST);