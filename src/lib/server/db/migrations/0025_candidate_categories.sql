-- A category is a specialization and a grade confirmed by a test (domain 12.4): `candidate_categories` and objections to
-- test results (`assessment_objections`, domain 12.5) replace the categorization by axes and its disputes. The
-- calculation over the profile evidence stays and is renamed: `categorization_runs` → `evidence_runs` (domain 12.6);
-- its axes, outcome, missing grounds and manual overrides go with the disputes. `decision_id` gets its foreign key with
-- `grade_decisions`. What the candidate states is the survey's, not a fact: the source `self_declared` and the fact
-- type `questionnaire` leave `source_facts` (domain 9.1). The market is keyed by a category (domain 12.8).
CREATE TABLE "assessment_objections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"items" uuid[],
	"opened_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"assignee_id" uuid,
	"status" text NOT NULL,
	"outcome" text,
	"resolution" text,
	"resulting_decision_id" uuid,
	"resolved_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_objections_status_values" CHECK ("assessment_objections"."status" in ('open', 'in_review', 'resolved', 'withdrawn')),
	CONSTRAINT "assessment_objections_outcome_values" CHECK ("assessment_objections"."outcome" in ('upheld', 'annulled', 'rescored')),
	CONSTRAINT "assessment_objections_reason_length" CHECK (char_length("assessment_objections"."reason") between 1 and 2000),
	CONSTRAINT "assessment_objections_due" CHECK ("assessment_objections"."due_at" = "assessment_objections"."opened_at" + interval '30 days'),
	CONSTRAINT "assessment_objections_assignee" CHECK ("assessment_objections"."status" <> 'in_review' or "assessment_objections"."assignee_id" is not null),
	CONSTRAINT "assessment_objections_resolution" CHECK (("assessment_objections"."status" = 'resolved') = ("assessment_objections"."outcome" is not null and "assessment_objections"."resolution" is not null and "assessment_objections"."resolved_at" is not null)),
	CONSTRAINT "assessment_objections_resulting_decision" CHECK (("assessment_objections"."resulting_decision_id" is not null) = ("assessment_objections"."outcome" is not distinct from 'rescored'))
);
--> statement-breakpoint
CREATE TABLE "candidate_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"specialization" text NOT NULL,
	"grade" text NOT NULL,
	"catalog_version" text NOT NULL,
	"decision_id" uuid NOT NULL,
	"bank_release_id" text NOT NULL,
	"confirmed_blocks" text[] NOT NULL,
	"confirmed_skill_keys" text[] NOT NULL,
	"confident_upgrade_until" timestamp with time zone,
	"status" text NOT NULL,
	"assigned_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_categories_specialization_values" CHECK ("candidate_categories"."specialization" in ('backend', 'frontend', 'mobile', 'data_ml', 'qa', 'devops')),
	CONSTRAINT "candidate_categories_grade_values" CHECK ("candidate_categories"."grade" in ('intern', 'junior', 'middle', 'senior')),
	CONSTRAINT "candidate_categories_status_values" CHECK ("candidate_categories"."status" in ('active', 'superseded', 'revoked')),
	CONSTRAINT "candidate_categories_revoke_reason_values" CHECK ("candidate_categories"."revoke_reason" in ('decision_annulled', 'objection_annulled', 'objection_rescored')),
	CONSTRAINT "candidate_categories_ended" CHECK (("candidate_categories"."status" = 'active') = ("candidate_categories"."ended_at" is null)),
	CONSTRAINT "candidate_categories_revoke_reason" CHECK (("candidate_categories"."status" = 'revoked') = ("candidate_categories"."revoke_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "category_assignments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "category_disputes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "category_assignments" CASCADE;--> statement-breakpoint
DROP TABLE "category_disputes" CASCADE;--> statement-breakpoint
ALTER TABLE "categorization_runs" RENAME TO "evidence_runs";--> statement-breakpoint
ALTER TABLE "match_scores" RENAME COLUMN "categorization_run_id" TO "evidence_run_id";--> statement-breakpoint
ALTER TABLE "match_scores" DROP CONSTRAINT "match_scores_snapshot";--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP CONSTRAINT "categorization_runs_origin_values";--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP CONSTRAINT "categorization_runs_outcome_values";--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP CONSTRAINT "categorization_runs_status_values";--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP CONSTRAINT "categorization_runs_input_snapshot_sha256_format";--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP CONSTRAINT "categorization_runs_override";--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP CONSTRAINT "categorization_runs_input_revision";--> statement-breakpoint
ALTER TABLE "source_facts" DROP CONSTRAINT "source_facts_source_values";--> statement-breakpoint
ALTER TABLE "source_facts" DROP CONSTRAINT "source_facts_fact_type_values";--> statement-breakpoint
ALTER TABLE "market_snapshots" DROP CONSTRAINT "market_snapshots_category_role";--> statement-breakpoint
-- Written by hand: what the generator does not express. Notifications of disputes go with the disputes, the
-- notification category of objections takes over the settings of the disputes, the jobs of the removed types are
-- carried over to the evidence calculation or cancelled, facts stated by the candidate leave with what rests on them,
-- and the market snapshots by role are dropped: the next `market.refresh` writes them by category.
DELETE FROM "notification_deliveries" WHERE "notification_id" IN (SELECT "id" FROM "notifications" WHERE "type" LIKE 'dispute.%');--> statement-breakpoint
DELETE FROM "notifications" WHERE "type" LIKE 'dispute.%';--> statement-breakpoint
UPDATE "notification_preferences" SET "category" = 'objections' WHERE "category" = 'disputes';--> statement-breakpoint
UPDATE "jobs" SET "status" = 'cancelled', "finished_at" = now() WHERE "type" = 'dispute.deadline_watch' AND "status" = 'queued';--> statement-breakpoint
UPDATE "jobs" SET "type" = 'evidence.compute', "dedup_key" = 'evidence:' || ("payload"->>'candidate_id') WHERE "type" = 'categorization.compute' AND "status" = 'queued';--> statement-breakpoint
DELETE FROM "verification_receipts" WHERE "fact_id" IN (SELECT "id" FROM "source_facts" WHERE "source" = 'self_declared' OR "fact_type" = 'questionnaire');--> statement-breakpoint
DELETE FROM "claims" WHERE "fact_id" IN (SELECT "id" FROM "source_facts" WHERE "source" = 'self_declared' OR "fact_type" = 'questionnaire');--> statement-breakpoint
DELETE FROM "experience_entries" WHERE "fact_id" IN (SELECT "id" FROM "source_facts" WHERE "source" = 'self_declared' OR "fact_type" = 'questionnaire');--> statement-breakpoint
DELETE FROM "source_facts" WHERE "source" = 'self_declared' OR "fact_type" = 'questionnaire';--> statement-breakpoint
DELETE FROM "market_snapshots";--> statement-breakpoint
-- End of the hand-written part.
ALTER TABLE "notification_preferences" DROP CONSTRAINT "notification_preferences_category_values";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_category_values";--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP CONSTRAINT "categorization_runs_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP CONSTRAINT "categorization_runs_taxonomy_version_id_taxonomy_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP CONSTRAINT "categorization_runs_ruleset_id_categorization_rulesets_id_fk";
--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP CONSTRAINT "categorization_runs_job_id_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP CONSTRAINT "categorization_runs_override_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "fsp_level_assignments" DROP CONSTRAINT "fsp_level_assignments_run_id_categorization_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "skill_inferences" DROP CONSTRAINT "skill_inferences_run_id_categorization_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "match_scores" DROP CONSTRAINT "match_scores_categorization_run_id_categorization_runs_id_fk";
--> statement-breakpoint
DROP INDEX "categorization_runs_published";--> statement-breakpoint
DROP INDEX "categorization_runs_candidate";--> statement-breakpoint
ALTER TABLE "assessment_objections" ADD CONSTRAINT "assessment_objections_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_objections" ADD CONSTRAINT "assessment_objections_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_categories" ADD CONSTRAINT "candidate_categories_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_objections_open" ON "assessment_objections" USING btree ("decision_id") WHERE "assessment_objections"."status" in ('open', 'in_review');--> statement-breakpoint
CREATE INDEX "assessment_objections_candidate" ON "assessment_objections" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "assessment_objections_open_due" ON "assessment_objections" USING btree ("due_at") WHERE "assessment_objections"."status" in ('open', 'in_review');--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_categories_active" ON "candidate_categories" USING btree ("candidate_id","specialization") WHERE "candidate_categories"."status" = 'active';--> statement-breakpoint
CREATE INDEX "candidate_categories_decision" ON "candidate_categories" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "candidate_categories_filter" ON "candidate_categories" USING btree ("specialization","grade") WHERE "candidate_categories"."status" = 'active';--> statement-breakpoint
ALTER TABLE "evidence_runs" ADD CONSTRAINT "evidence_runs_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_runs" ADD CONSTRAINT "evidence_runs_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_runs" ADD CONSTRAINT "evidence_runs_ruleset_id_categorization_rulesets_id_fk" FOREIGN KEY ("ruleset_id") REFERENCES "public"."categorization_rulesets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_runs" ADD CONSTRAINT "evidence_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fsp_level_assignments" ADD CONSTRAINT "fsp_level_assignments_run_id_evidence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."evidence_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_inferences" ADD CONSTRAINT "skill_inferences_run_id_evidence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."evidence_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_evidence_run_id_evidence_runs_id_fk" FOREIGN KEY ("evidence_run_id") REFERENCES "public"."evidence_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_runs_published" ON "evidence_runs" USING btree ("candidate_id") WHERE "evidence_runs"."status" = 'published';--> statement-breakpoint
CREATE INDEX "evidence_runs_candidate" ON "evidence_runs" USING btree ("candidate_id","computed_at");--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP COLUMN "origin";--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP COLUMN "override_by";--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP COLUMN "override_reason";--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP COLUMN "outcome";--> statement-breakpoint
ALTER TABLE "evidence_runs" DROP COLUMN "missing";--> statement-breakpoint
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_snapshot" UNIQUE NULLS NOT DISTINCT("vacancy_id","vacancy_revision","candidate_id","candidate_revision","evidence_run_id","match_ruleset_id");--> statement-breakpoint
ALTER TABLE "evidence_runs" ADD CONSTRAINT "evidence_runs_status_values" CHECK ("evidence_runs"."status" in ('computed', 'published', 'superseded', 'blocked', 'discarded_stale'));--> statement-breakpoint
ALTER TABLE "evidence_runs" ADD CONSTRAINT "evidence_runs_input_snapshot_sha256_format" CHECK ("evidence_runs"."input_snapshot_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "evidence_runs" ADD CONSTRAINT "evidence_runs_input_revision" CHECK ("evidence_runs"."input_revision" >= 0);--> statement-breakpoint
ALTER TABLE "source_facts" ADD CONSTRAINT "source_facts_source_values" CHECK ("source_facts"."source" in ('fsp', 'platform_test', 'codeforces', 'github', 'resume'));--> statement-breakpoint
ALTER TABLE "source_facts" ADD CONSTRAINT "source_facts_fact_type_values" CHECK ("source_facts"."fact_type" in ('competition_result', 'qualification', 'national_team', 'platform_rating', 'test_score', 'repo_languages', 'resume_document'));--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_category_specialization" CHECK ("market_snapshots"."category_key" ? 'specialization' and not "market_snapshots"."category_key" ? 'role_key');--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_category_values" CHECK ("notification_preferences"."category" in ('invitations', 'hiring', 'deadlines', 'objections', 'account'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_category_values" CHECK ("notifications"."category" in ('invitations', 'hiring', 'deadlines', 'objections', 'account'));
