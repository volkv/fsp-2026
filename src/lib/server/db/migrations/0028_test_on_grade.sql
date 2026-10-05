CREATE TABLE "bank_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"specialization" text NOT NULL,
	"catalog_version" text NOT NULL,
	"procedure_version" text NOT NULL,
	"content_sha256" text NOT NULL,
	"shared_sha256" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" text NOT NULL,
	"released_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "bank_releases_status_values" CHECK ("bank_releases"."status" in ('released', 'retired')),
	CONSTRAINT "bank_releases_content_sha256_format" CHECK ("bank_releases"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bank_releases_shared_sha256_format" CHECK ("bank_releases"."shared_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bank_releases_retired" CHECK (("bank_releases"."status" = 'retired') = ("bank_releases"."retired_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "grade_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"specialization" text NOT NULL,
	"grade" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"confident" boolean NOT NULL,
	"llr" bigint NOT NULL,
	"score_sum" integer NOT NULL,
	"cut_sum" integer NOT NULL,
	"items" integer NOT NULL,
	"extension_used" boolean NOT NULL,
	"practice" jsonb,
	"blocks" jsonb NOT NULL,
	"procedure_version" text NOT NULL,
	"bank_release_id" text NOT NULL,
	"status" text NOT NULL,
	"supersedes_decision_id" uuid,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "grade_decisions_outcome_values" CHECK ("grade_decisions"."outcome" in ('confirmed', 'not_confirmed', 'undetermined')),
	CONSTRAINT "grade_decisions_reason_values" CHECK ("grade_decisions"."reason" in ('sprt_upper', 'sprt_lower', 'forced_upper_at_max', 'forced_lower_at_max', 'forced_upper_final', 'forced_lower_final', 'band_after_extension', 'practice_gate_failed', 'defining_block_failed', 'bank_exhausted', 'rescored_incomplete')),
	CONSTRAINT "grade_decisions_status_values" CHECK ("grade_decisions"."status" in ('valid', 'annulled', 'superseded')),
	CONSTRAINT "grade_decisions_confident" CHECK (not "grade_decisions"."confident" or "grade_decisions"."outcome" = 'confirmed')
);
--> statement-breakpoint
CREATE TABLE "test_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"content" jsonb,
	"file_id" uuid,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_until" date NOT NULL,
	CONSTRAINT "test_artifacts_attempt_seq" UNIQUE("attempt_id","seq"),
	CONSTRAINT "test_artifacts_kind_values" CHECK ("test_artifacts"."kind" in ('answer', 'code_submission', 'run_result', 'qa_cases')),
	CONSTRAINT "test_artifacts_sha256_format" CHECK ("test_artifacts"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "test_artifacts_seq_positive" CHECK ("test_artifacts"."seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "test_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"specialization" text NOT NULL,
	"grade" text NOT NULL,
	"catalog_version" text NOT NULL,
	"bank_release_id" text NOT NULL,
	"procedure_version" text NOT NULL,
	"policy_version" integer NOT NULL,
	"form" text,
	"via_confident_upgrade" boolean DEFAULT false NOT NULL,
	"seed" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"confirmation_request_id" uuid,
	"integrity_signals" jsonb,
	"seeded" boolean DEFAULT false NOT NULL,
	"annulled_by" uuid,
	"annulled_at" timestamp with time zone,
	"annul_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_attempts_purpose_values" CHECK ("test_attempts"."purpose" in ('grade', 'vacancy_block', 'recheck')),
	CONSTRAINT "test_attempts_status_values" CHECK ("test_attempts"."status" in ('in_progress', 'decided', 'expired', 'annulled')),
	CONSTRAINT "test_attempts_form_values" CHECK ("test_attempts"."form" in ('A', 'B')),
	CONSTRAINT "test_attempts_annul_reason_values" CHECK ("test_attempts"."annul_reason" in ('plagiarism', 'candidate_request', 'technical_failure', 'version_defect', 'objection_upheld')),
	CONSTRAINT "test_attempts_form" CHECK (("test_attempts"."purpose" = 'grade') = ("test_attempts"."form" is not null)),
	CONSTRAINT "test_attempts_seed_format" CHECK ("test_attempts"."seed" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "test_attempts_annulment" CHECK (("test_attempts"."status" = 'annulled') = ("test_attempts"."annulled_at" is not null and "test_attempts"."annul_reason" is not null)),
	CONSTRAINT "test_attempts_ended" CHECK (("test_attempts"."status" = 'in_progress') = ("test_attempts"."ended_at" is null)),
	CONSTRAINT "test_attempts_confirmation_request" CHECK (("test_attempts"."purpose" = 'vacancy_block') = ("test_attempts"."confirmation_request_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "test_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"block" text NOT NULL,
	"format" text NOT NULL,
	"practice" boolean NOT NULL,
	"family_key" text NOT NULL,
	"family_version" integer NOT NULL,
	"class_id" text NOT NULL,
	"instance_seed" text NOT NULL,
	"instance" jsonb NOT NULL,
	"angoff" numeric(3, 2) NOT NULL,
	"served_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"score" numeric(3, 2),
	"score_detail" jsonb,
	"status" text NOT NULL,
	CONSTRAINT "test_items_attempt_seq" UNIQUE("attempt_id","seq"),
	CONSTRAINT "test_items_status_values" CHECK ("test_items"."status" in ('served', 'answered', 'scored', 'awaiting_sandbox')),
	CONSTRAINT "test_items_seq_positive" CHECK ("test_items"."seq" >= 1),
	CONSTRAINT "test_items_angoff_range" CHECK ("test_items"."angoff" > 0 and "test_items"."angoff" < 1 and mod("test_items"."angoff" * 20, 1) = 0),
	CONSTRAINT "test_items_score_range" CHECK ("test_items"."score" is null or ("test_items"."score" >= 0 and "test_items"."score" <= 1 and mod("test_items"."score" * 20, 1) = 0)),
	CONSTRAINT "test_items_scored" CHECK (("test_items"."status" = 'scored') = ("test_items"."score" is not null))
);
--> statement-breakpoint
ALTER TABLE "assessment_artifacts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assessment_attempts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assessment_scores" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assessment_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assessments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "assessment_artifacts" CASCADE;--> statement-breakpoint
DROP TABLE "assessment_attempts" CASCADE;--> statement-breakpoint
DROP TABLE "assessment_scores" CASCADE;--> statement-breakpoint
DROP TABLE "assessment_versions" CASCADE;--> statement-breakpoint
DROP TABLE "assessments" CASCADE;--> statement-breakpoint
ALTER TABLE "grade_decisions" ADD CONSTRAINT "grade_decisions_attempt_id_test_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."test_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_decisions" ADD CONSTRAINT "grade_decisions_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_decisions" ADD CONSTRAINT "grade_decisions_bank_release_id_bank_releases_id_fk" FOREIGN KEY ("bank_release_id") REFERENCES "public"."bank_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_decisions" ADD CONSTRAINT "grade_decisions_supersedes_decision_id_grade_decisions_id_fk" FOREIGN KEY ("supersedes_decision_id") REFERENCES "public"."grade_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_artifacts" ADD CONSTRAINT "test_artifacts_attempt_id_test_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."test_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_artifacts" ADD CONSTRAINT "test_artifacts_item_id_test_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."test_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_artifacts" ADD CONSTRAINT "test_artifacts_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_bank_release_id_bank_releases_id_fk" FOREIGN KEY ("bank_release_id") REFERENCES "public"."bank_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_annulled_by_users_id_fk" FOREIGN KEY ("annulled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_items" ADD CONSTRAINT "test_items_attempt_id_test_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."test_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_releases_one_released" ON "bank_releases" USING btree ("specialization") WHERE "bank_releases"."status" = 'released';--> statement-breakpoint
CREATE UNIQUE INDEX "grade_decisions_one_valid" ON "grade_decisions" USING btree ("attempt_id") WHERE "grade_decisions"."status" = 'valid';--> statement-breakpoint
CREATE INDEX "grade_decisions_candidate" ON "grade_decisions" USING btree ("candidate_id","specialization");--> statement-breakpoint
CREATE INDEX "test_artifacts_item" ON "test_artifacts" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_attempts_one_in_progress" ON "test_attempts" USING btree ("candidate_id") WHERE "test_attempts"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "test_attempts_candidate" ON "test_attempts" USING btree ("candidate_id","specialization","grade");--> statement-breakpoint
ALTER TABLE "assessment_objections" ADD CONSTRAINT "assessment_objections_decision_id_grade_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."grade_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_objections" ADD CONSTRAINT "assessment_objections_resulting_decision_id_grade_decisions_id_fk" FOREIGN KEY ("resulting_decision_id") REFERENCES "public"."grade_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_categories" ADD CONSTRAINT "candidate_categories_decision_id_grade_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."grade_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Written by hand (not expressed by the schema). The guard of the removed `assessment_artifacts` goes with its table.
DROP FUNCTION assessment_artifacts_guard();
--> statement-breakpoint

-- Artifacts of an attempt are append-only, except that after `retention_until` the retention role clears the content and
-- the file reference, and removes the rows of a purged account; the row, its hash and the score stay (domain 10.7). An
-- open objection holds them: `retention_until` may move later, never earlier, and nothing else changes.
CREATE FUNCTION test_artifacts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF current_user = 'fsp_retention' THEN
		IF TG_OP = 'DELETE' THEN
			RETURN OLD;
		END IF;
		IF NEW.content IS NULL AND NEW.file_id IS NULL
			AND (to_jsonb(NEW) - 'content' - 'file_id') = (to_jsonb(OLD) - 'content' - 'file_id') THEN
			RETURN NEW;
		END IF;
	END IF;
	IF TG_OP = 'UPDATE' AND NEW.retention_until >= OLD.retention_until
		AND (to_jsonb(NEW) - 'retention_until') = (to_jsonb(OLD) - 'retention_until') THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'table test_artifacts is append-only: % is not allowed', TG_OP
		USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER test_artifacts_append_only BEFORE UPDATE OR DELETE ON test_artifacts
	FOR EACH ROW EXECUTE FUNCTION test_artifacts_guard();
--> statement-breakpoint
GRANT SELECT, DELETE, UPDATE (content, file_id) ON test_artifacts TO fsp_retention;
--> statement-breakpoint

-- Grade decisions are append-only: only `status` goes `valid → annulled` or `valid → superseded` (a review's new decision
-- replaces it); the retention role removes the rows of a purged account (domain 10.7).
CREATE FUNCTION grade_decisions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' AND current_user = 'fsp_retention' THEN
		RETURN OLD;
	END IF;
	IF TG_OP = 'UPDATE' AND OLD.status = 'valid' AND NEW.status IN ('annulled', 'superseded')
		AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'table grade_decisions is append-only: % is not allowed', TG_OP
		USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER grade_decisions_append_only BEFORE UPDATE OR DELETE ON grade_decisions
	FOR EACH ROW EXECUTE FUNCTION grade_decisions_guard();
--> statement-breakpoint
GRANT SELECT, DELETE ON grade_decisions TO fsp_retention;
--> statement-breakpoint

-- The retention sweep skips artifacts of an attempt with an open objection: the retention role reads the objections.
GRANT SELECT ON assessment_objections TO fsp_retention;
