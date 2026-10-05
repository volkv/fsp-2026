CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"vacancy_id" uuid NOT NULL,
	"message" text,
	"match" jsonb,
	"status" text NOT NULL,
	"invitation_id" uuid,
	"submitted_at" timestamp with time zone NOT NULL,
	"viewed_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_candidate_vacancy" UNIQUE("candidate_id","vacancy_id"),
	CONSTRAINT "applications_status_values" CHECK ("applications"."status" in ('submitted', 'viewed', 'invited', 'rejected', 'withdrawn')),
	CONSTRAINT "applications_message_length" CHECK (char_length("applications"."message") between 1 and 2000),
	CONSTRAINT "applications_match" CHECK ("applications"."purged_at" is not null or jsonb_typeof("applications"."match") = 'object'),
	CONSTRAINT "applications_purged" CHECK ("applications"."purged_at" is null or ("applications"."message" is null and "applications"."match" is null)),
	CONSTRAINT "applications_invited" CHECK ("applications"."status" <> 'invited' or "applications"."invitation_id" is not null),
	CONSTRAINT "applications_closed" CHECK (("applications"."status" in ('rejected', 'withdrawn')) = ("applications"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "block_confirmations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"specialization" text NOT NULL,
	"block" text NOT NULL,
	"grade" text NOT NULL,
	"verdict" text NOT NULL,
	"score_sum" integer NOT NULL,
	"cut_sum" integer NOT NULL,
	"bank_release_id" text NOT NULL,
	"status" text NOT NULL,
	"visibility" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "block_confirmations_attempt" UNIQUE("attempt_id"),
	CONSTRAINT "block_confirmations_specialization_values" CHECK ("block_confirmations"."specialization" in ('backend', 'frontend', 'mobile', 'data_ml', 'qa', 'devops')),
	CONSTRAINT "block_confirmations_grade_values" CHECK ("block_confirmations"."grade" in ('intern', 'junior', 'middle', 'senior')),
	CONSTRAINT "block_confirmations_verdict_values" CHECK ("block_confirmations"."verdict" in ('confirmed', 'not_confirmed')),
	CONSTRAINT "block_confirmations_status_values" CHECK ("block_confirmations"."status" in ('valid', 'annulled')),
	CONSTRAINT "block_confirmations_visibility_values" CHECK ("block_confirmations"."visibility" in ('requester', 'all_companies')),
	CONSTRAINT "block_confirmations_sums" CHECK ("block_confirmations"."score_sum" >= 0 and "block_confirmations"."cut_sum" > 0),
	CONSTRAINT "block_confirmations_verdict" CHECK (("block_confirmations"."verdict" = 'confirmed') = ("block_confirmations"."score_sum" >= "block_confirmations"."cut_sum"))
);
--> statement-breakpoint
CREATE TABLE "challenge_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"challenge_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challenge_deliveries_pair" UNIQUE("challenge_id","candidate_id"),
	CONSTRAINT "challenge_deliveries_status_values" CHECK ("challenge_deliveries"."status" in ('delivered', 'opened', 'solved', 'dismissed', 'expired')),
	CONSTRAINT "challenge_deliveries_opened" CHECK ("challenge_deliveries"."status" in ('delivered', 'expired') or "challenge_deliveries"."opened_at" is not null),
	CONSTRAINT "challenge_deliveries_reminded" CHECK ("challenge_deliveries"."reminded_at" is null or "challenge_deliveries"."reminded_at" >= "challenge_deliveries"."delivered_at")
);
--> statement-breakpoint
CREATE TABLE "challenge_solutions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delivery_id" uuid NOT NULL,
	"content" text,
	"submitted_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"company_decision" text,
	"decided_at" timestamp with time zone,
	"decided_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challenge_solutions_delivery" UNIQUE("delivery_id"),
	CONSTRAINT "challenge_solutions_status_values" CHECK ("challenge_solutions"."status" in ('submitted', 'withdrawn')),
	CONSTRAINT "challenge_solutions_company_decision_values" CHECK ("challenge_solutions"."company_decision" in ('invited', 'dismissed')),
	CONSTRAINT "challenge_solutions_content" CHECK (case "challenge_solutions"."status"
				when 'submitted' then char_length("challenge_solutions"."content") between 1 and 20000 and "challenge_solutions"."withdrawn_at" is null
				else "challenge_solutions"."content" is null and "challenge_solutions"."withdrawn_at" is not null end),
	CONSTRAINT "challenge_solutions_decision" CHECK (("challenge_solutions"."company_decision" is null) = ("challenge_solutions"."decided_at" is null) and ("challenge_solutions"."company_decision" is null) = ("challenge_solutions"."decided_by_member_id" is null))
);
--> statement-breakpoint
CREATE TABLE "company_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"title" text NOT NULL,
	"statement" text NOT NULL,
	"answer_kind" text NOT NULL,
	"specialization" text NOT NULL,
	"grades" text[] NOT NULL,
	"salary_min" integer,
	"salary_max" integer,
	"salary_currency" text,
	"salary_period" text,
	"salary_tax_base" text,
	"goal" text NOT NULL,
	"time_limit_minutes" integer NOT NULL,
	"status" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone NOT NULL,
	"text_check" jsonb NOT NULL,
	"last_delivery_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_challenges_answer_kind_values" CHECK ("company_challenges"."answer_kind" in ('solution', 'approach')),
	CONSTRAINT "company_challenges_status_values" CHECK ("company_challenges"."status" in ('draft', 'active', 'closed')),
	CONSTRAINT "company_challenges_specialization_values" CHECK ("company_challenges"."specialization" in ('backend', 'frontend', 'mobile', 'data_ml', 'qa', 'devops')),
	CONSTRAINT "company_challenges_grades" CHECK (cardinality("company_challenges"."grades") between 1 and 4 and "company_challenges"."grades" <@ array['intern', 'junior', 'middle', 'senior']::text[]),
	CONSTRAINT "company_challenges_salary_bounds" CHECK (("company_challenges"."salary_min" is null or "company_challenges"."salary_min" >= 0) and ("company_challenges"."salary_max" is null or "company_challenges"."salary_max" >= 0)
				and ("company_challenges"."salary_min" is null or "company_challenges"."salary_max" is null or "company_challenges"."salary_min" <= "company_challenges"."salary_max")),
	CONSTRAINT "company_challenges_salary_terms" CHECK (("company_challenges"."salary_min" is null and "company_challenges"."salary_max" is null)
				or ("company_challenges"."salary_currency" is not null and "company_challenges"."salary_period" is not null and "company_challenges"."salary_tax_base" is not null)),
	CONSTRAINT "company_challenges_salary_currency_format" CHECK ("company_challenges"."salary_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "company_challenges_salary_period_values" CHECK ("company_challenges"."salary_period" in ('month', 'year', 'hour', 'project')),
	CONSTRAINT "company_challenges_salary_tax_base_values" CHECK ("company_challenges"."salary_tax_base" in ('gross', 'net', 'unknown')),
	CONSTRAINT "company_challenges_full_salary" CHECK ("company_challenges"."salary_min" is not null and "company_challenges"."salary_max" is not null and "company_challenges"."salary_tax_base" in ('gross', 'net')),
	CONSTRAINT "company_challenges_salary_rub" CHECK ("company_challenges"."salary_currency" = 'RUB' and "company_challenges"."salary_period" = 'month'),
	CONSTRAINT "company_challenges_title_length" CHECK (char_length("company_challenges"."title") between 1 and 120),
	CONSTRAINT "company_challenges_statement_length" CHECK (char_length("company_challenges"."statement") between 50 and 5000),
	CONSTRAINT "company_challenges_goal_length" CHECK (char_length("company_challenges"."goal") between 1 and 500),
	CONSTRAINT "company_challenges_time_limit" CHECK ("company_challenges"."time_limit_minutes" between 5 and 30),
	CONSTRAINT "company_challenges_started" CHECK ("company_challenges"."status" = 'draft' or "company_challenges"."starts_at" is not null),
	CONSTRAINT "company_challenges_period" CHECK ("company_challenges"."starts_at" is null or "company_challenges"."ends_at" > "company_challenges"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "confirmation_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"requested_by_member_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"invitation_id" uuid,
	"need_id" uuid,
	"specialization" text NOT NULL,
	"block" text NOT NULL,
	"grade" text NOT NULL,
	"status" text NOT NULL,
	"confirmation_id" uuid,
	"answered_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "confirmation_requests_status_values" CHECK ("confirmation_requests"."status" in ('requested', 'accepted', 'declined', 'completed', 'expired')),
	CONSTRAINT "confirmation_requests_specialization_values" CHECK ("confirmation_requests"."specialization" in ('backend', 'frontend', 'mobile', 'data_ml', 'qa', 'devops')),
	CONSTRAINT "confirmation_requests_grade_values" CHECK ("confirmation_requests"."grade" in ('intern', 'junior', 'middle', 'senior')),
	CONSTRAINT "confirmation_requests_completed" CHECK (("confirmation_requests"."status" = 'completed') = ("confirmation_requests"."confirmation_id" is not null)),
	CONSTRAINT "confirmation_requests_answered" CHECK ("confirmation_requests"."status" in ('requested', 'expired') or "confirmation_requests"."answered_at" is not null),
	CONSTRAINT "confirmation_requests_expiry" CHECK ("confirmation_requests"."expires_at" > "confirmation_requests"."created_at")
);
--> statement-breakpoint
ALTER TABLE "consent_events" DROP CONSTRAINT "consent_events_scope";--> statement-breakpoint
ALTER TABLE "source_facts" DROP CONSTRAINT "source_facts_fact_type_values";--> statement-breakpoint
ALTER TABLE "product_policies" DROP CONSTRAINT "product_policies_kind_values";--> statement-breakpoint
ALTER TABLE "disclosures" ALTER COLUMN "invitation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_events" ADD COLUMN "scope_application_id" uuid;--> statement-breakpoint
ALTER TABLE "disclosures" ADD COLUMN "application_id" uuid;--> statement-breakpoint
ALTER TABLE "demo_sessions" ADD COLUMN "clock_offset_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_vacancy_id_vacancies_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block_confirmations" ADD CONSTRAINT "block_confirmations_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block_confirmations" ADD CONSTRAINT "block_confirmations_attempt_id_test_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."test_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block_confirmations" ADD CONSTRAINT "block_confirmations_bank_release_id_bank_releases_id_fk" FOREIGN KEY ("bank_release_id") REFERENCES "public"."bank_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_deliveries" ADD CONSTRAINT "challenge_deliveries_challenge_id_company_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."company_challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_deliveries" ADD CONSTRAINT "challenge_deliveries_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_solutions" ADD CONSTRAINT "challenge_solutions_delivery_id_challenge_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."challenge_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_solutions" ADD CONSTRAINT "challenge_solutions_decided_by_member_id_company_members_id_fk" FOREIGN KEY ("decided_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_challenges" ADD CONSTRAINT "company_challenges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_challenges" ADD CONSTRAINT "company_challenges_created_by_member_id_company_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_requests" ADD CONSTRAINT "confirmation_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_requests" ADD CONSTRAINT "confirmation_requests_requested_by_member_id_company_members_id_fk" FOREIGN KEY ("requested_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_requests" ADD CONSTRAINT "confirmation_requests_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_requests" ADD CONSTRAINT "confirmation_requests_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_requests" ADD CONSTRAINT "confirmation_requests_need_id_hiring_needs_id_fk" FOREIGN KEY ("need_id") REFERENCES "public"."hiring_needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmation_requests" ADD CONSTRAINT "confirmation_requests_confirmation_id_block_confirmations_id_fk" FOREIGN KEY ("confirmation_id") REFERENCES "public"."block_confirmations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_company" ON "applications" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "applications_vacancy" ON "applications" USING btree ("vacancy_id");--> statement-breakpoint
CREATE INDEX "block_confirmations_candidate" ON "block_confirmations" USING btree ("candidate_id","block");--> statement-breakpoint
CREATE INDEX "challenge_deliveries_candidate" ON "challenge_deliveries" USING btree ("candidate_id","delivered_at");--> statement-breakpoint
CREATE INDEX "company_challenges_company" ON "company_challenges" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "company_challenges_active" ON "company_challenges" USING btree ("specialization") WHERE "company_challenges"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "confirmation_requests_open" ON "confirmation_requests" USING btree ("company_id","candidate_id","block","grade") WHERE "confirmation_requests"."status" in ('requested', 'accepted');--> statement-breakpoint
CREATE INDEX "confirmation_requests_candidate" ON "confirmation_requests" USING btree ("candidate_id","status");--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_confirmation_request_id_confirmation_requests_id_fk" FOREIGN KEY ("confirmation_request_id") REFERENCES "public"."confirmation_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_scope_application_id_applications_id_fk" FOREIGN KEY ("scope_application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disclosures_application" ON "disclosures" USING btree ("application_id");--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_scope" CHECK (case "consent_events"."kind"
				when 'contact_disclosure' then "consent_events"."scope_company_id" is not null and num_nonnulls("consent_events"."scope_invitation_id", "consent_events"."scope_application_id") = 1 and "consent_events"."scope_competition_ref" is null
				when 'partner_pool' then "consent_events"."scope_competition_ref" is not null and "consent_events"."scope_company_id" is null and "consent_events"."scope_invitation_id" is null and "consent_events"."scope_application_id" is null
				else "consent_events"."scope_company_id" is null and "consent_events"."scope_invitation_id" is null and "consent_events"."scope_application_id" is null and "consent_events"."scope_competition_ref" is null end);--> statement-breakpoint
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_basis" CHECK (num_nonnulls("disclosures"."invitation_id", "disclosures"."application_id") = 1);--> statement-breakpoint
ALTER TABLE "demo_sessions" ADD CONSTRAINT "demo_sessions_clock_offset" CHECK ("demo_sessions"."clock_offset_seconds" >= 0);--> statement-breakpoint
ALTER TABLE "source_facts" ADD CONSTRAINT "source_facts_fact_type_values" CHECK ("source_facts"."fact_type" in ('competition_result', 'qualification', 'national_team', 'platform_rating', 'test_score', 'test_block', 'repo_languages', 'resume_document'));--> statement-breakpoint
ALTER TABLE "product_policies" ADD CONSTRAINT "product_policies_kind_values" CHECK ("product_policies"."kind" in ('invitation_policy', 'hiring_policy', 'notification_policy', 'minor_policy', 'catalog_policy', 'market_policy', 'sourcing_policy', 'assessment_policy', 'retention_policy', 'matching_policy', 'challenge_policy'));--> statement-breakpoint

-- Written by hand (drizzle-kit does not express deferrable keys): a request names the result that closed it, the result
-- names its attempt, the attempt names its request (domain 13.11, 23.2). The request's key to the result is checked at
-- commit, so the rows of a candidate or a demo session are inserted and removed in one transaction in either order.
ALTER TABLE confirmation_requests ALTER CONSTRAINT confirmation_requests_confirmation_id_block_confirmations_id_fk
	DEFERRABLE INITIALLY DEFERRED;
