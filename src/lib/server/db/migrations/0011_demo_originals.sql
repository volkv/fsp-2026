ALTER TABLE "candidates" ADD COLUMN "demo_original" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "demo_original" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_demo_original" CHECK (not "candidates"."demo_original" or "candidates"."demo_session_id" is null);--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_demo_original" CHECK (not "companies"."demo_original" or "companies"."demo_session_id" is null);