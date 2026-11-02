ALTER TABLE "products" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_source_ref_unique" UNIQUE("source_ref");