ALTER TABLE "jobs" ADD COLUMN "owner" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_owner_values" CHECK ("jobs"."owner" in ('demo_seed'));