CREATE TABLE "demo_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"join_token_sha256" text NOT NULL,
	"seed_batch_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"own_resume_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_sessions_join_token" UNIQUE("join_token_sha256"),
	CONSTRAINT "demo_sessions_join_token_sha256_format" CHECK ("demo_sessions"."join_token_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "demo_sessions_expiry" CHECK ("demo_sessions"."expires_at" > "demo_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "consent_events" DROP CONSTRAINT "consent_events_kind_values";--> statement-breakpoint
ALTER TABLE "consent_events" DROP CONSTRAINT "consent_events_adult_only_kinds";--> statement-breakpoint
ALTER TABLE "legal_documents" DROP CONSTRAINT "legal_documents_kind_values";--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "demo_session_id" uuid;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "demo_session_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "demo_session_id" uuid;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_demo_session_id_demo_sessions_id_fk" FOREIGN KEY ("demo_session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_demo_session_id_demo_sessions_id_fk" FOREIGN KEY ("demo_session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_demo_session_id_demo_sessions_id_fk" FOREIGN KEY ("demo_session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidates_demo_session" ON "candidates" USING btree ("demo_session_id") WHERE "candidates"."demo_session_id" is not null;--> statement-breakpoint
CREATE INDEX "companies_demo_session" ON "companies" USING btree ("demo_session_id") WHERE "companies"."demo_session_id" is not null;--> statement-breakpoint
CREATE INDEX "users_demo_session" ON "users" USING btree ("demo_session_id") WHERE "users"."demo_session_id" is not null;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_kind_values" CHECK ("consent_events"."kind" in ('pd_processing', 'catalog_visibility', 'partner_pool', 'telegram_notifications', 'fsp_import', 'contact_disclosure', 'public_distribution', 'automated_decision_written', 'demo_resume_upload'));--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_adult_only_kinds" CHECK ("consent_events"."kind" not in ('partner_pool', 'public_distribution', 'demo_resume_upload') or "consent_events"."signer_kind" <> 'representative');--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_kind_values" CHECK ("legal_documents"."kind" in ('pd_processing', 'catalog_visibility', 'partner_pool', 'telegram_notifications', 'fsp_import', 'contact_disclosure', 'public_distribution', 'automated_decision_written', 'demo_resume_upload', 'user_agreement', 'employer_terms', 'minor_employment_terms'));