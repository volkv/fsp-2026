CREATE TABLE "hiring_needs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"text" text,
	"form" jsonb NOT NULL,
	"parse" jsonb,
	"text_check" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hiring_needs_status_values" CHECK ("hiring_needs"."status" in ('draft', 'active', 'closed')),
	CONSTRAINT "hiring_needs_text_length" CHECK (char_length("hiring_needs"."text") between 1 and 5000),
	CONSTRAINT "hiring_needs_parse_with_text" CHECK ("hiring_needs"."parse" is null or "hiring_needs"."text" is not null)
);
--> statement-breakpoint
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_company_vacancy_candidate";--> statement-breakpoint
ALTER TABLE "companies" DROP CONSTRAINT "companies_verified_at";--> statement-breakpoint
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_vacancy_id_vacancies_id_fk";
--> statement-breakpoint
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_match_score_id_match_scores_id_fk";
--> statement-breakpoint
ALTER TABLE "invitation_terms" ALTER COLUMN "vacancy_snapshot" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "activity" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "contacts" jsonb;--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD COLUMN "title" text NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD COLUMN "description" text NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD COLUMN "vacancy_id" uuid;--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD COLUMN "category" jsonb;--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD COLUMN "work_format" text NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD COLUMN "contact_method" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD COLUMN "why_you" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD COLUMN "text_check" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "need_id" uuid;--> statement-breakpoint
ALTER TABLE "hiring_needs" ADD CONSTRAINT "hiring_needs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_needs" ADD CONSTRAINT "hiring_needs_created_by_member_id_company_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hiring_needs_company" ON "hiring_needs" USING btree ("company_id","status");--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD CONSTRAINT "invitation_terms_vacancy_id_vacancies_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_need_id_hiring_needs_id_fk" FOREIGN KEY ("need_id") REFERENCES "public"."hiring_needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitation_terms_vacancy" ON "invitation_terms" USING btree ("vacancy_id") WHERE "invitation_terms"."vacancy_id" is not null;--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN "vacancy_id";--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN "match_score_id";--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_company_candidate" UNIQUE("company_id","candidate_id");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_description_length" CHECK (char_length("companies"."description") between 1 and 3000);--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_activity_length" CHECK (char_length("companies"."activity") between 1 and 200);--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_contacts_object" CHECK (jsonb_typeof("companies"."contacts") = 'object');--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_verified_at" CHECK ("companies"."status" <> 'verified' or "companies"."verified_at" is not null);--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD CONSTRAINT "invitation_terms_salary_rub" CHECK ("invitation_terms"."salary_currency" = 'RUB' and "invitation_terms"."salary_period" = 'month');--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD CONSTRAINT "invitation_terms_title_length" CHECK (char_length("invitation_terms"."title") between 1 and 120);--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD CONSTRAINT "invitation_terms_description_length" CHECK (char_length("invitation_terms"."description") between 50 and 5000);--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD CONSTRAINT "invitation_terms_message_length" CHECK (char_length("invitation_terms"."message") between 1 and 2000);--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD CONSTRAINT "invitation_terms_vacancy_snapshot" CHECK (("invitation_terms"."vacancy_id" is null) = ("invitation_terms"."vacancy_snapshot" is null));--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD CONSTRAINT "invitation_terms_why_you" CHECK (jsonb_typeof("invitation_terms"."why_you") = 'array' and jsonb_array_length("invitation_terms"."why_you") between 1 and 5);