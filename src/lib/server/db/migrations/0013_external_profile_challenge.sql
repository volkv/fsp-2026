DROP INDEX "external_profiles_candidate";--> statement-breakpoint
ALTER TABLE "external_profiles" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "external_profiles" ADD COLUMN "challenge_code" text;--> statement-breakpoint
ALTER TABLE "external_profiles" ADD COLUMN "challenge_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_profiles" ADD COLUMN "challenge_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_profiles" ADD COLUMN "sync_status" text;--> statement-breakpoint
ALTER TABLE "external_profiles" ADD COLUMN "sync_error" text;--> statement-breakpoint
ALTER TABLE "external_profiles" ADD COLUMN "sync_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_profiles" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "external_profiles_candidate_platform" ON "external_profiles" USING btree ("candidate_id","platform");--> statement-breakpoint
ALTER TABLE "external_profiles" ADD CONSTRAINT "external_profiles_sync_status_values" CHECK ("external_profiles"."sync_status" in ('pending', 'ok', 'source_unavailable', 'not_found'));--> statement-breakpoint
ALTER TABLE "external_profiles" ADD CONSTRAINT "external_profiles_challenge" CHECK (("external_profiles"."challenge_code" is null) = ("external_profiles"."challenge_expires_at" is null));--> statement-breakpoint
ALTER TABLE "external_profiles" ADD CONSTRAINT "external_profiles_verified_state" CHECK ("external_profiles"."ownership_status" <> 'verified' or "external_profiles"."challenge_code" is null);--> statement-breakpoint
ALTER TABLE "external_profiles" ADD CONSTRAINT "external_profiles_sync_verified" CHECK ("external_profiles"."sync_status" is null or "external_profiles"."ownership_status" = 'verified');--> statement-breakpoint
ALTER TABLE "external_profiles" ADD CONSTRAINT "external_profiles_challenge_attempts" CHECK ("external_profiles"."challenge_attempts" >= 0);