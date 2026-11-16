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
CREATE INDEX "outbox_published_at_id_idx" ON "outbox" USING btree ("published_at","id");