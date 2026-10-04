CREATE TABLE "assessment_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"content" jsonb,
	"file_id" uuid,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_until" date NOT NULL,
	CONSTRAINT "assessment_artifacts_attempt_seq" UNIQUE("attempt_id","seq"),
	CONSTRAINT "assessment_artifacts_kind_values" CHECK ("assessment_artifacts"."kind" in ('answer', 'code_submission', 'run_result', 'quiz_step')),
	CONSTRAINT "assessment_artifacts_sha256_format" CHECK ("assessment_artifacts"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_artifacts_seq_positive" CHECK ("assessment_artifacts"."seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "assessment_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"integrity_signals" jsonb,
	"annulled_by" uuid,
	"annulled_at" timestamp with time zone,
	"annul_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_attempts_status_values" CHECK ("assessment_attempts"."status" in ('started', 'submitted', 'scored', 'expired', 'annulled')),
	CONSTRAINT "assessment_attempts_annul_reason_values" CHECK ("assessment_attempts"."annul_reason" in ('plagiarism', 'technical_failure', 'version_defect', 'candidate_request')),
	CONSTRAINT "assessment_attempts_annulment" CHECK (("assessment_attempts"."status" = 'annulled') = ("assessment_attempts"."annulled_at" is not null and "assessment_attempts"."annul_reason" is not null)),
	CONSTRAINT "assessment_attempts_submitted" CHECK ("assessment_attempts"."status" not in ('submitted', 'scored') or "assessment_attempts"."submitted_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "assessment_scores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"score" numeric NOT NULL,
	"max_score" numeric NOT NULL,
	"level" text NOT NULL,
	"scored_by" text NOT NULL,
	"scorer_version" text NOT NULL,
	"supersedes_score_id" uuid,
	"review_reason" text,
	"reviewer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_scores_supersedes" UNIQUE("supersedes_score_id"),
	CONSTRAINT "assessment_scores_scored_by_values" CHECK ("assessment_scores"."scored_by" in ('automatic', 'human_review')),
	CONSTRAINT "assessment_scores_range" CHECK ("assessment_scores"."max_score" > 0 and "assessment_scores"."score" >= 0 and "assessment_scores"."score" <= "assessment_scores"."max_score"),
	CONSTRAINT "assessment_scores_review_reason" CHECK ("assessment_scores"."supersedes_score_id" is null or "assessment_scores"."review_reason" is not null),
	CONSTRAINT "assessment_scores_human_reviewer" CHECK ("assessment_scores"."scored_by" <> 'human_review' or "assessment_scores"."reviewer_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "assessment_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"assessment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"scorer" jsonb NOT NULL,
	"level_scale" jsonb NOT NULL,
	"coverage" jsonb NOT NULL,
	"item_bank" jsonb,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_versions_assessment_version" UNIQUE("assessment_id","version"),
	CONSTRAINT "assessment_versions_status_values" CHECK ("assessment_versions"."status" in ('draft', 'published', 'retired', 'defective')),
	CONSTRAINT "assessment_versions_content_sha256_format" CHECK ("assessment_versions"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_versions_version_positive" CHECK ("assessment_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"skill_keys" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessments_kind_values" CHECK ("assessments"."kind" in ('code_task', 'quiz', 'open_answer')),
	CONSTRAINT "assessments_skill_keys" CHECK (cardinality("assessments"."skill_keys") >= 1)
);
--> statement-breakpoint
-- Edited after generation: drizzle-kit has no declarative partitioning, the journal is partitioned by month
-- (docs/domain.md, section 18.1). Partitions are created in 0002_database_rules.sql.
CREATE TABLE "audit_events" (
	"id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"actor_company_id" uuid,
	"api_key_id" uuid,
	"object_type" text,
	"object_id" text,
	"subject_candidate_id" uuid,
	"request_id" text NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"details" jsonb,
	CONSTRAINT "audit_events_pk" PRIMARY KEY("id","occurred_at"),
	CONSTRAINT "audit_events_outcome_values" CHECK ("audit_events"."outcome" in ('success', 'denied', 'failure')),
	CONSTRAINT "audit_events_actor_kind_values" CHECK ("audit_events"."actor_kind" in ('user', 'api_key', 'system', 'anonymous')),
	CONSTRAINT "audit_events_user_actor" CHECK ("audit_events"."actor_kind" <> 'user' or "audit_events"."actor_user_id" is not null),
	CONSTRAINT "audit_events_api_key_actor" CHECK ("audit_events"."actor_kind" <> 'api_key' or "audit_events"."api_key_id" is not null),
	CONSTRAINT "audit_events_object" CHECK (("audit_events"."object_type" is null) = ("audit_events"."object_id" is null))
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
CREATE TABLE "erasure_ledger" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"purged_at" timestamp with time zone,
	CONSTRAINT "erasure_ledger_order" CHECK ("erasure_ledger"."purged_at" is null or "erasure_ledger"."purged_at" >= "erasure_ledger"."requested_at")
);
--> statement-breakpoint
CREATE TABLE "candidate_company_blocks" (
	"candidate_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_company_blocks_pk" PRIMARY KEY("candidate_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"profile_revision" bigint DEFAULT 0 NOT NULL,
	"evidence_floor_revision" bigint DEFAULT 0 NOT NULL,
	"last_name_enc" "bytea",
	"first_name_enc" "bytea",
	"middle_name_enc" "bytea",
	"phone_enc" "bytea",
	"birth_date" date,
	"birth_date_precision" text,
	"birth_date_source" text,
	"birth_date_status" text DEFAULT 'unknown' NOT NULL,
	"birth_date_verified_by" uuid,
	"birth_date_verified_at" timestamp with time zone,
	"eligible_from" date,
	"visibility" text DEFAULT 'hidden' NOT NULL,
	"search_status" text NOT NULL,
	"headline" text,
	"desired_role_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"preferences" jsonb NOT NULL,
	"purge_after" date,
	"seed_batch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidates_user" UNIQUE("user_id"),
	CONSTRAINT "candidates_status_values" CHECK ("candidates"."status" in ('onboarding', 'active', 'ineligible_age', 'deletion_pending', 'deleted')),
	CONSTRAINT "candidates_birth_date_precision_values" CHECK ("candidates"."birth_date_precision" in ('day', 'year')),
	CONSTRAINT "candidates_birth_date_source_values" CHECK ("candidates"."birth_date_source" in ('self_declared', 'fsp_import', 'operator_document')),
	CONSTRAINT "candidates_birth_date_status_values" CHECK ("candidates"."birth_date_status" in ('unknown', 'unverified', 'verified', 'conflict')),
	CONSTRAINT "candidates_visibility_values" CHECK ("candidates"."visibility" in ('hidden', 'catalog')),
	CONSTRAINT "candidates_search_status_values" CHECK ("candidates"."search_status" in ('active', 'open_to_offers', 'not_looking')),
	CONSTRAINT "candidates_revisions" CHECK ("candidates"."profile_revision" >= 0 and "candidates"."evidence_floor_revision" >= 0 and "candidates"."evidence_floor_revision" <= "candidates"."profile_revision"),
	CONSTRAINT "candidates_ineligible_age" CHECK (case when "candidates"."status" = 'ineligible_age'
				then "candidates"."birth_date" is null and "candidates"."eligible_from" is not null
				else "candidates"."eligible_from" is null end),
	CONSTRAINT "candidates_birth_date_fields" CHECK (case when "candidates"."birth_date" is null
				then "candidates"."birth_date_precision" is null and "candidates"."birth_date_source" is null and "candidates"."birth_date_status" = 'unknown'
				else "candidates"."birth_date_precision" is not null and "candidates"."birth_date_source" is not null and "candidates"."birth_date_status" <> 'unknown' end),
	CONSTRAINT "candidates_birth_date_verification" CHECK (("candidates"."birth_date_status" = 'verified') = ("candidates"."birth_date_verified_at" is not null)),
	CONSTRAINT "candidates_desired_roles" CHECK (cardinality("candidates"."desired_role_keys") <= 3),
	CONSTRAINT "candidates_tombstone" CHECK ("candidates"."status" <> 'deleted' or ("candidates"."last_name_enc" is null and "candidates"."first_name_enc" is null
				and "candidates"."middle_name_enc" is null and "candidates"."phone_enc" is null and "candidates"."birth_date" is null and "candidates"."headline" is null))
);
--> statement-breakpoint
CREATE TABLE "external_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"ownership_status" text NOT NULL,
	"ownership_method" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_profiles_platform_values" CHECK ("external_profiles"."platform" in ('codeforces', 'github')),
	CONSTRAINT "external_profiles_ownership_status_values" CHECK ("external_profiles"."ownership_status" in ('unverified', 'verified')),
	CONSTRAINT "external_profiles_ownership_method_values" CHECK ("external_profiles"."ownership_method" in ('oauth', 'handle_challenge')),
	CONSTRAINT "external_profiles_verification" CHECK (("external_profiles"."ownership_status" = 'verified') = ("external_profiles"."verified_at" is not null and "external_profiles"."ownership_method" is not null))
);
--> statement-breakpoint
CREATE TABLE "categorization_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"input_revision" bigint NOT NULL,
	"input_snapshot_sha256" text NOT NULL,
	"input_refs" jsonb NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"ruleset_id" uuid NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"job_id" uuid,
	"origin" text NOT NULL,
	"override_by" uuid,
	"override_reason" text,
	"outcome" text NOT NULL,
	"missing" jsonb NOT NULL,
	"experience_summary" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categorization_runs_origin_values" CHECK ("categorization_runs"."origin" in ('automatic', 'manual_override')),
	CONSTRAINT "categorization_runs_outcome_values" CHECK ("categorization_runs"."outcome" in ('complete', 'partial', 'insufficient_data')),
	CONSTRAINT "categorization_runs_status_values" CHECK ("categorization_runs"."status" in ('computed', 'published', 'superseded', 'blocked', 'discarded_stale')),
	CONSTRAINT "categorization_runs_input_snapshot_sha256_format" CHECK ("categorization_runs"."input_snapshot_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "categorization_runs_override" CHECK (("categorization_runs"."origin" = 'manual_override') = ("categorization_runs"."override_by" is not null and "categorization_runs"."override_reason" is not null)),
	CONSTRAINT "categorization_runs_input_revision" CHECK ("categorization_runs"."input_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "category_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"rank" text NOT NULL,
	"role_status" text NOT NULL,
	"role_key" text,
	"grade_status" text NOT NULL,
	"grade_min" text,
	"grade_max" text,
	"grade_confidence" numeric(3, 2),
	"stack_status" text NOT NULL,
	"stack_skill_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"score" numeric,
	"explanation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_assignments_rank_values" CHECK ("category_assignments"."rank" in ('primary', 'secondary')),
	CONSTRAINT "category_assignments_role_status_values" CHECK ("category_assignments"."role_status" in ('established', 'insufficient_data')),
	CONSTRAINT "category_assignments_grade_status_values" CHECK ("category_assignments"."grade_status" in ('established', 'insufficient_data')),
	CONSTRAINT "category_assignments_stack_status_values" CHECK ("category_assignments"."stack_status" in ('established', 'insufficient_data')),
	CONSTRAINT "category_assignments_role_axis" CHECK (case when "category_assignments"."role_status" = 'established'
				then "category_assignments"."role_key" is not null
				else "category_assignments"."role_key" is null and "category_assignments"."score" is null end),
	CONSTRAINT "category_assignments_grade_axis" CHECK (case when "category_assignments"."grade_status" = 'established'
				then "category_assignments"."grade_min" is not null and "category_assignments"."grade_max" is not null and "category_assignments"."grade_confidence" is not null
					and "category_assignments"."grade_confidence" >= 0 and "category_assignments"."grade_confidence" <= 1
				else "category_assignments"."grade_min" is null and "category_assignments"."grade_max" is null and "category_assignments"."grade_confidence" is null end),
	CONSTRAINT "category_assignments_stack_axis" CHECK (case when "category_assignments"."stack_status" = 'established'
				then cardinality("category_assignments"."stack_skill_keys") between 1 and 3
				else cardinality("category_assignments"."stack_skill_keys") = 0 end),
	CONSTRAINT "category_assignments_some_axis" CHECK ('established' in ("category_assignments"."role_status", "category_assignments"."grade_status", "category_assignments"."stack_status")),
	CONSTRAINT "category_assignments_secondary_role" CHECK ("category_assignments"."rank" = 'primary' or "category_assignments"."role_status" = 'established')
);
--> statement-breakpoint
CREATE TABLE "category_disputes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"assignee_id" uuid,
	"status" text NOT NULL,
	"resolution" text,
	"resulting_run_id" uuid,
	"resolved_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_disputes_status_values" CHECK ("category_disputes"."status" in ('open', 'in_review', 'resolved_upheld', 'resolved_changed', 'withdrawn')),
	CONSTRAINT "category_disputes_due" CHECK ("category_disputes"."due_at" = "category_disputes"."opened_at" + interval '30 days'),
	CONSTRAINT "category_disputes_assignee" CHECK ("category_disputes"."status" <> 'in_review' or "category_disputes"."assignee_id" is not null),
	CONSTRAINT "category_disputes_resolution" CHECK (("category_disputes"."status" in ('resolved_upheld', 'resolved_changed')) = ("category_disputes"."resolution" is not null and "category_disputes"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "fsp_level_assignments" (
	"run_id" uuid NOT NULL,
	"discipline" text NOT NULL,
	"level" text NOT NULL,
	"basis_fact_ids" uuid[] NOT NULL,
	"last_result_on" date,
	CONSTRAINT "fsp_level_assignments_pk" PRIMARY KEY("run_id","discipline"),
	CONSTRAINT "fsp_level_assignments_level_values" CHECK ("fsp_level_assignments"."level" in ('L1', 'L2', 'L3', 'L4', 'L5')),
	CONSTRAINT "fsp_level_assignments_basis" CHECK (cardinality("fsp_level_assignments"."basis_fact_ids") >= 1)
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"permissions" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_prefix" UNIQUE("prefix"),
	CONSTRAINT "api_keys_secret_hash" UNIQUE("secret_hash"),
	CONSTRAINT "api_keys_prefix_format" CHECK (char_length("api_keys"."prefix") = 8),
	CONSTRAINT "api_keys_secret_hash_format" CHECK ("api_keys"."secret_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"inn" text NOT NULL,
	"ogrn" text,
	"kpp" text,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text NOT NULL,
	"registry_snapshot" jsonb,
	"verified_at" timestamp with time zone,
	"minor_terms_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_status_values" CHECK ("companies"."status" in ('draft', 'submitted', 'verified', 'rejected', 'suspended')),
	CONSTRAINT "companies_inn_format" CHECK ("companies"."inn" ~ '^([0-9]{10}|[0-9]{12})$'),
	CONSTRAINT "companies_verified_at" CHECK ("companies"."status" not in ('verified', 'suspended') or "companies"."verified_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "company_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid,
	"invited_email_hmac" text,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"invited_by" uuid,
	"joined_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_members_role_values" CHECK ("company_members"."role" in ('owner', 'recruiter')),
	CONSTRAINT "company_members_status_values" CHECK ("company_members"."status" in ('invited', 'active', 'removed')),
	CONSTRAINT "company_members_status_fields" CHECK (case "company_members"."status"
				when 'invited' then "company_members"."invited_email_hmac" is not null
				when 'active' then "company_members"."user_id" is not null and "company_members"."joined_at" is not null
				else "company_members"."removed_at" is not null end)
);
--> statement-breakpoint
CREATE TABLE "company_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"applicant_member_id" uuid NOT NULL,
	"registry_check" jsonb,
	"authority_method" text NOT NULL,
	"authority_evidence_file_id" uuid,
	"decision" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_verifications_authority_method_values" CHECK ("company_verifications"."authority_method" in ('director_self', 'power_of_attorney', 'corporate_email_domain', 'signed_letter', 'esign')),
	CONSTRAINT "company_verifications_decision_values" CHECK ("company_verifications"."decision" in ('approved', 'rejected')),
	CONSTRAINT "company_verifications_decision_fields" CHECK (("company_verifications"."decision" is null) = ("company_verifications"."decided_by" is null) and ("company_verifications"."decision" is null) = ("company_verifications"."decided_at" is null)),
	CONSTRAINT "company_verifications_rejection_reason" CHECK ("company_verifications"."decision" is distinct from 'rejected' or "company_verifications"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "competition_partnerships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"competition_ref" text NOT NULL,
	"competition_source" text NOT NULL,
	"kind" text NOT NULL,
	"pool_rule" jsonb NOT NULL,
	"status" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"granted_by" uuid NOT NULL,
	"basis" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_partnerships_competition_source_values" CHECK ("competition_partnerships"."competition_source" in ('fsp')),
	CONSTRAINT "competition_partnerships_kind_values" CHECK ("competition_partnerships"."kind" in ('case_provider', 'sponsor', 'organizer_partner')),
	CONSTRAINT "competition_partnerships_status_values" CHECK ("competition_partnerships"."status" in ('active', 'ended')),
	CONSTRAINT "competition_partnerships_validity" CHECK ("competition_partnerships"."valid_to" is null or "competition_partnerships"."valid_to" >= "competition_partnerships"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "authority_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"representation_id" uuid NOT NULL,
	"method" text NOT NULL,
	"basis_kind" text NOT NULL,
	"basis_note" text,
	"evidence_file_id" uuid,
	"evidence_retention_until" date,
	"checked_by" uuid NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"result" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authority_checks_method_values" CHECK ("authority_checks"."method" in ('document_upload', 'document_presented', 'in_person', 'esia')),
	CONSTRAINT "authority_checks_basis_kind_values" CHECK ("authority_checks"."basis_kind" in ('birth_certificate', 'adoption_decision', 'guardianship_act', 'custodianship_act')),
	CONSTRAINT "authority_checks_result_values" CHECK ("authority_checks"."result" in ('verified', 'rejected')),
	CONSTRAINT "authority_checks_evidence_method" CHECK ("authority_checks"."evidence_file_id" is null or "authority_checks"."method" = 'document_upload'),
	CONSTRAINT "authority_checks_evidence_retention" CHECK (("authority_checks"."evidence_file_id" is null) = ("authority_checks"."evidence_retention_until" is null))
);
--> statement-breakpoint
CREATE TABLE "consent_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_candidate_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"document_id" uuid NOT NULL,
	"action" text NOT NULL,
	"signer_kind" text NOT NULL,
	"signer_user_id" uuid,
	"representation_id" uuid,
	"scope_company_id" uuid,
	"scope_invitation_id" uuid,
	"scope_competition_ref" text,
	"scope_fields" text[],
	"choices" jsonb,
	"method" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "consent_events_kind_values" CHECK ("consent_events"."kind" in ('pd_processing', 'catalog_visibility', 'partner_pool', 'telegram_notifications', 'fsp_import', 'contact_disclosure', 'public_distribution', 'automated_decision_written')),
	CONSTRAINT "consent_events_action_values" CHECK ("consent_events"."action" in ('grant', 'revoke', 'lapse')),
	CONSTRAINT "consent_events_signer_kind_values" CHECK ("consent_events"."signer_kind" in ('subject', 'representative', 'system')),
	CONSTRAINT "consent_events_method_values" CHECK ("consent_events"."method" in ('separate_screen_button', 'email_link', 'esign', 'system')),
	CONSTRAINT "consent_events_signer" CHECK (case "consent_events"."signer_kind"
				when 'subject' then "consent_events"."signer_user_id" is not null and "consent_events"."representation_id" is null and "consent_events"."method" <> 'system'
				when 'representative' then "consent_events"."representation_id" is not null and "consent_events"."signer_user_id" is null and "consent_events"."method" <> 'system'
				else "consent_events"."action" = 'lapse' and "consent_events"."method" = 'system' and "consent_events"."signer_user_id" is null and "consent_events"."representation_id" is null end),
	CONSTRAINT "consent_events_adult_only_kinds" CHECK ("consent_events"."kind" not in ('partner_pool', 'public_distribution') or "consent_events"."signer_kind" <> 'representative'),
	CONSTRAINT "consent_events_scope" CHECK (case "consent_events"."kind"
				when 'contact_disclosure' then "consent_events"."scope_company_id" is not null and "consent_events"."scope_invitation_id" is not null and "consent_events"."scope_competition_ref" is null
				when 'partner_pool' then "consent_events"."scope_competition_ref" is not null and "consent_events"."scope_company_id" is null and "consent_events"."scope_invitation_id" is null
				else "consent_events"."scope_company_id" is null and "consent_events"."scope_invitation_id" is null and "consent_events"."scope_competition_ref" is null end),
	CONSTRAINT "consent_events_scope_fields" CHECK (case "consent_events"."kind"
				when 'catalog_visibility' then "consent_events"."scope_fields" is null or "consent_events"."scope_fields" <@ array['fsp_achievements_exact', 'external_profiles']::text[]
				when 'contact_disclosure' then "consent_events"."action" <> 'grant'
					or ("consent_events"."scope_fields" <@ array['full_name', 'email', 'phone', 'resume']::text[] and "consent_events"."scope_fields" @> array['full_name', 'email']::text[])
				when 'public_distribution' then "consent_events"."scope_fields" is null or "consent_events"."scope_fields" <@ array['full_name', 'email', 'phone', 'city', 'categories', 'desired_roles', 'fsp_levels', 'skills', 'fsp_achievements', 'external_profiles']::text[]
				else "consent_events"."scope_fields" is null end)
);
--> statement-breakpoint
CREATE TABLE "disclosures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"recipient_member_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"consent_event_id" uuid NOT NULL,
	"fields" text[] NOT NULL,
	"channel" text NOT NULL,
	"disclosed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "disclosures_channel_values" CHECK ("disclosures"."channel" in ('ui', 'api')),
	CONSTRAINT "disclosures_fields" CHECK (cardinality("disclosures"."fields") > 0 and "disclosures"."fields" <@ array['full_name', 'email', 'phone', 'resume']::text[])
);
--> statement-breakpoint
CREATE TABLE "document_acceptances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid,
	"accepted_at" timestamp with time zone NOT NULL,
	"ip" "inet",
	"ua" text
);
--> statement-breakpoint
CREATE TABLE "legal_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"body_sha256" text NOT NULL,
	"pd_operator_id" uuid NOT NULL,
	"operator_snapshot" jsonb NOT NULL,
	"processors_snapshot" jsonb NOT NULL,
	"purposes" text[] NOT NULL,
	"data_categories" text[] NOT NULL,
	"operations" text[] NOT NULL,
	"form" text NOT NULL,
	"available" boolean NOT NULL,
	"requires_reconsent" boolean NOT NULL,
	"published_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_documents_kind_version" UNIQUE("kind","version"),
	CONSTRAINT "legal_documents_kind_values" CHECK ("legal_documents"."kind" in ('pd_processing', 'catalog_visibility', 'partner_pool', 'telegram_notifications', 'fsp_import', 'contact_disclosure', 'public_distribution', 'automated_decision_written', 'user_agreement', 'employer_terms', 'minor_employment_terms')),
	CONSTRAINT "legal_documents_form_values" CHECK ("legal_documents"."form" in ('electronic_separate_screen', 'electronic_signature')),
	CONSTRAINT "legal_documents_body_sha256_format" CHECK ("legal_documents"."body_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legal_documents_version_positive" CHECK ("legal_documents"."version" >= 1),
	CONSTRAINT "legal_documents_superseded_after_publication" CHECK ("legal_documents"."superseded_at" is null or "legal_documents"."published_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "legal_representatives" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_name_enc" "bytea" NOT NULL,
	"email_enc" "bytea" NOT NULL,
	"email_hmac" text NOT NULL,
	"phone_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pd_operators" (
	"id" uuid PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"inn" text NOT NULL,
	"ogrn" text NOT NULL,
	"address" text NOT NULL,
	"contact_email" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pd_operators_validity" CHECK ("pd_operators"."valid_to" is null or "pd_operators"."valid_to" >= "pd_operators"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "representations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"representative_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"status" text NOT NULL,
	"invited_at" timestamp with time zone NOT NULL,
	"contact_confirmed_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "representations_relation_values" CHECK ("representations"."relation" in ('parent', 'adoptive_parent', 'guardian', 'custodian')),
	CONSTRAINT "representations_status_values" CHECK ("representations"."status" in ('invited', 'contact_confirmed', 'authority_pending', 'authority_verified', 'ended')),
	CONSTRAINT "representations_end_reason_values" CHECK ("representations"."end_reason" in ('majority', 'revoked_by_representative', 'authority_rejected', 'operator_revoked', 'candidate_deleted', 'invitation_expired')),
	CONSTRAINT "representations_end" CHECK (("representations"."status" = 'ended') = ("representations"."ended_at" is not null) and ("representations"."status" = 'ended') = ("representations"."end_reason" is not null)),
	CONSTRAINT "representations_contact_confirmed" CHECK ("representations"."status" not in ('contact_confirmed', 'authority_pending', 'authority_verified') or "representations"."contact_confirmed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "document_extractions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resume_document_id" uuid NOT NULL,
	"extractor_name" text NOT NULL,
	"extractor_version" text NOT NULL,
	"input_sha256" text NOT NULL,
	"status" text NOT NULL,
	"text" text NOT NULL,
	"blocks" jsonb NOT NULL,
	"flags" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_extractions_document_version" UNIQUE("resume_document_id","extractor_version"),
	CONSTRAINT "document_extractions_status_values" CHECK ("document_extractions"."status" in ('complete', 'partial')),
	CONSTRAINT "document_extractions_input_sha256_format" CHECK ("document_extractions"."input_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"declared_name" text NOT NULL,
	"detected_mime" text NOT NULL,
	"status" text NOT NULL,
	"retention_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_storage_key" UNIQUE("storage_key"),
	CONSTRAINT "files_purpose_values" CHECK ("files"."purpose" in ('resume', 'authority_evidence', 'company_authority_evidence', 'assessment_artifact', 'source_batch', 'export')),
	CONSTRAINT "files_status_values" CHECK ("files"."status" in ('uploaded', 'ready', 'rejected', 'deleted')),
	CONSTRAINT "files_sha256_format" CHECK ("files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "files_size" CHECK ("files"."size_bytes" >= 0),
	CONSTRAINT "files_resume_size" CHECK ("files"."purpose" <> 'resume' or "files"."size_bytes" <= 10485760)
);
--> statement-breakpoint
CREATE TABLE "resume_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"is_current" boolean NOT NULL,
	"parse_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_documents_candidate_seq" UNIQUE("candidate_id","seq"),
	CONSTRAINT "resume_documents_parse_status_values" CHECK ("resume_documents"."parse_status" in ('pending', 'parsed', 'partial', 'unsupported_format', 'failed')),
	CONSTRAINT "resume_documents_seq_positive" CHECK ("resume_documents"."seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"claim_type" text NOT NULL,
	"experience_entry_id" uuid,
	"event_key" text,
	"raw_text" text NOT NULL,
	"polarity" text NOT NULL,
	"skill_key" text,
	"normalization" jsonb,
	"value" jsonb,
	"quote" jsonb,
	"extractor" text NOT NULL,
	"ml_result_id" uuid,
	"candidate_review" text DEFAULT 'pending' NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_claim_type_values" CHECK ("claims"."claim_type" in ('skill_mention', 'experience_period', 'role_title', 'organization', 'education', 'team_role', 'responsibility_marker', 'language_level', 'achievement_mention')),
	CONSTRAINT "claims_polarity_values" CHECK ("claims"."polarity" in ('asserted', 'negated', 'uncertain')),
	CONSTRAINT "claims_extractor_values" CHECK ("claims"."extractor" in ('rules', 'model', 'source_mapping')),
	CONSTRAINT "claims_candidate_review_values" CHECK ("claims"."candidate_review" in ('pending', 'confirmed', 'rejected')),
	CONSTRAINT "claims_status_values" CHECK ("claims"."status" in ('active', 'invalidated')),
	CONSTRAINT "claims_document_quote" CHECK ("claims"."extractor" = 'source_mapping' or "claims"."quote" is not null),
	CONSTRAINT "claims_model_result" CHECK ("claims"."extractor" <> 'model' or "claims"."ml_result_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "experience_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"position_title" text,
	"role_key" text,
	"organization_name" text,
	"period_from" date,
	"period_to" date,
	"period_from_precision" text,
	"period_to_precision" text,
	"is_current" boolean NOT NULL,
	"applied_skill_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"quotes" jsonb NOT NULL,
	"period_status" text NOT NULL,
	"candidate_review" text DEFAULT 'pending' NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experience_entries_period_from_precision_values" CHECK ("experience_entries"."period_from_precision" in ('month', 'year')),
	CONSTRAINT "experience_entries_period_to_precision_values" CHECK ("experience_entries"."period_to_precision" in ('month', 'year')),
	CONSTRAINT "experience_entries_period_status_values" CHECK ("experience_entries"."period_status" in ('valid', 'missing', 'invalid')),
	CONSTRAINT "experience_entries_candidate_review_values" CHECK ("experience_entries"."candidate_review" in ('pending', 'confirmed', 'rejected', 'edited')),
	CONSTRAINT "experience_entries_status_values" CHECK ("experience_entries"."status" in ('active', 'invalidated')),
	CONSTRAINT "experience_entries_quotes" CHECK (jsonb_typeof("experience_entries"."quotes") = 'array' and jsonb_array_length("experience_entries"."quotes") >= 1),
	CONSTRAINT "experience_entries_current_open" CHECK (not "experience_entries"."is_current" or "experience_entries"."period_to" is null),
	CONSTRAINT "experience_entries_valid_period" CHECK ("experience_entries"."period_status" <> 'valid' or ("experience_entries"."period_from" is not null and "experience_entries"."period_from_precision" is not null
				and ("experience_entries"."period_to" is null or ("experience_entries"."period_to" >= "experience_entries"."period_from" and "experience_entries"."period_to_precision" is not null))
				and ("experience_entries"."period_to" is not null or "experience_entries"."is_current")))
);
--> statement-breakpoint
CREATE TABLE "skill_inferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"skill_key" text NOT NULL,
	"strength" numeric(4, 3) NOT NULL,
	"strength_band" text NOT NULL,
	"attestation" text NOT NULL,
	"badge_trust" text,
	"contributions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_inferences_run_skill" UNIQUE("run_id","skill_key"),
	CONSTRAINT "skill_inferences_strength_band_values" CHECK ("skill_inferences"."strength_band" in ('weak', 'moderate', 'strong')),
	CONSTRAINT "skill_inferences_attestation_values" CHECK ("skill_inferences"."attestation" in ('direct', 'derived', 'claimed')),
	CONSTRAINT "skill_inferences_badge_trust_values" CHECK ("skill_inferences"."badge_trust" in ('fsp_verified', 'platform_verified', 'public_verifiable', 'claimed')),
	CONSTRAINT "skill_inferences_strength_range" CHECK ("skill_inferences"."strength" >= 0 and "skill_inferences"."strength" <= 1),
	CONSTRAINT "skill_inferences_badge" CHECK (("skill_inferences"."attestation" = 'direct') = ("skill_inferences"."badge_trust" is not null) and "skill_inferences"."badge_trust" is distinct from 'claimed')
);
--> statement-breakpoint
CREATE TABLE "source_facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"source" text NOT NULL,
	"fact_type" text NOT NULL,
	"source_record_ref" text NOT NULL,
	"event_key" text,
	"trust_level" text NOT NULL,
	"ownership_basis" text NOT NULL,
	"ownership_ref" uuid,
	"consent_event_id" uuid,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"source_snapshot_sha256" text,
	"source_version" text,
	"observed_at" timestamp with time zone NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	"occurred_on" date,
	"status" text NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_facts_source_values" CHECK ("source_facts"."source" in ('fsp', 'platform_test', 'codeforces', 'github', 'resume', 'self_declared')),
	CONSTRAINT "source_facts_fact_type_values" CHECK ("source_facts"."fact_type" in ('competition_result', 'qualification', 'national_team', 'platform_rating', 'test_score', 'repo_languages', 'resume_document', 'questionnaire')),
	CONSTRAINT "source_facts_trust_level_values" CHECK ("source_facts"."trust_level" in ('fsp_verified', 'platform_verified', 'public_verifiable', 'claimed')),
	CONSTRAINT "source_facts_ownership_basis_values" CHECK ("source_facts"."ownership_basis" in ('athlete_link', 'operator_confirmed', 'protocol_self_claim', 'own_attempt', 'oauth_account', 'handle_challenge', 'self_upload', 'self_declared')),
	CONSTRAINT "source_facts_status_values" CHECK ("source_facts"."status" in ('active', 'superseded', 'withdrawn', 'annulled')),
	CONSTRAINT "source_facts_payload_sha256_format" CHECK ("source_facts"."payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "source_facts_source_snapshot_sha256_format" CHECK ("source_facts"."source_snapshot_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "source_facts_fsp_consent" CHECK ("source_facts"."source" <> 'fsp' or "source_facts"."ownership_basis" <> 'athlete_link' or "source_facts"."consent_event_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "verification_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"fact_id" uuid NOT NULL,
	"fact_payload_sha256" text NOT NULL,
	"audience_company_id" uuid,
	"disclosure_level" text NOT NULL,
	"statement" jsonb NOT NULL,
	"statement_sha256" text NOT NULL,
	"signature" text NOT NULL,
	"signing_key_id" text NOT NULL,
	"commitment_nonce" "bytea" NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_receipts_handle" UNIQUE("handle"),
	CONSTRAINT "verification_receipts_audience_fact" UNIQUE NULLS NOT DISTINCT("fact_id","fact_payload_sha256","audience_company_id","disclosure_level"),
	CONSTRAINT "verification_receipts_disclosure_level_values" CHECK ("verification_receipts"."disclosure_level" in ('generalized', 'exact')),
	CONSTRAINT "verification_receipts_fact_payload_sha256_format" CHECK ("verification_receipts"."fact_payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "verification_receipts_statement_sha256_format" CHECK ("verification_receipts"."statement_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "verification_receipts_handle_format" CHECK ("verification_receipts"."handle" ~ '^[a-z2-7]{26}$')
);
--> statement-breakpoint
CREATE TABLE "hiring_processes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invitation_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"outcome_due_at" timestamp with time zone NOT NULL,
	"policy_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hiring_processes_invitation" UNIQUE("invitation_id"),
	CONSTRAINT "hiring_processes_due_after_open" CHECK ("hiring_processes"."outcome_due_at" > "hiring_processes"."opened_at")
);
--> statement-breakpoint
CREATE TABLE "hiring_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"process_id" uuid NOT NULL,
	"party" text NOT NULL,
	"reported_by_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"stage" text,
	"outcome" text,
	"start_date" date,
	"reason_code" text,
	"supersedes_report_id" uuid,
	"reported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hiring_reports_supersedes" UNIQUE("supersedes_report_id"),
	CONSTRAINT "hiring_reports_party_values" CHECK ("hiring_reports"."party" in ('company', 'candidate')),
	CONSTRAINT "hiring_reports_kind_values" CHECK ("hiring_reports"."kind" in ('stage', 'outcome')),
	CONSTRAINT "hiring_reports_stage_values" CHECK ("hiring_reports"."stage" in ('interview_scheduled', 'interview_done', 'offer_made', 'offer_accepted')),
	CONSTRAINT "hiring_reports_outcome_values" CHECK ("hiring_reports"."outcome" in ('hired', 'not_hired', 'candidate_withdrew', 'company_stopped', 'no_contact')),
	CONSTRAINT "hiring_reports_kind_fields" CHECK (case "hiring_reports"."kind"
				when 'stage' then "hiring_reports"."stage" is not null and "hiring_reports"."outcome" is null
				else "hiring_reports"."outcome" is not null and "hiring_reports"."stage" is null end),
	CONSTRAINT "hiring_reports_start_date" CHECK ("hiring_reports"."start_date" is null or "hiring_reports"."outcome" = 'hired')
);
--> statement-breakpoint
CREATE TABLE "invitation_responses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invitation_id" uuid NOT NULL,
	"terms_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason_code" text,
	"reason_text" text,
	"consent_event_id" uuid,
	"responded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "invitation_responses_terms" UNIQUE("terms_id"),
	CONSTRAINT "invitation_responses_decision_values" CHECK ("invitation_responses"."decision" in ('accept', 'decline')),
	CONSTRAINT "invitation_responses_decline_only_fields" CHECK ("invitation_responses"."decision" = 'decline' or ("invitation_responses"."reason_code" is null and "invitation_responses"."reason_text" is null)),
	CONSTRAINT "invitation_responses_consent_on_accept" CHECK ("invitation_responses"."decision" = 'accept' or "invitation_responses"."consent_event_id" is null)
);
--> statement-breakpoint
CREATE TABLE "invitation_terms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invitation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"vacancy_snapshot" jsonb NOT NULL,
	"salary_min" integer,
	"salary_max" integer,
	"salary_currency" text,
	"salary_period" text,
	"salary_tax_base" text,
	"message" text,
	"response_due_at" timestamp with time zone NOT NULL,
	"changes" jsonb,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_terms_invitation_version" UNIQUE("invitation_id","version"),
	CONSTRAINT "invitation_terms_salary_bounds" CHECK (("invitation_terms"."salary_min" is null or "invitation_terms"."salary_min" >= 0) and ("invitation_terms"."salary_max" is null or "invitation_terms"."salary_max" >= 0)
				and ("invitation_terms"."salary_min" is null or "invitation_terms"."salary_max" is null or "invitation_terms"."salary_min" <= "invitation_terms"."salary_max")),
	CONSTRAINT "invitation_terms_salary_terms" CHECK (("invitation_terms"."salary_min" is null and "invitation_terms"."salary_max" is null)
				or ("invitation_terms"."salary_currency" is not null and "invitation_terms"."salary_period" is not null and "invitation_terms"."salary_tax_base" is not null)),
	CONSTRAINT "invitation_terms_salary_currency_format" CHECK ("invitation_terms"."salary_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "invitation_terms_salary_period_values" CHECK ("invitation_terms"."salary_period" in ('month', 'year', 'hour', 'project')),
	CONSTRAINT "invitation_terms_salary_tax_base_values" CHECK ("invitation_terms"."salary_tax_base" in ('gross', 'net', 'unknown')),
	CONSTRAINT "invitation_terms_full_salary" CHECK ("invitation_terms"."salary_min" is not null and "invitation_terms"."salary_max" is not null and "invitation_terms"."salary_tax_base" in ('gross', 'net')),
	CONSTRAINT "invitation_terms_version_positive" CHECK ("invitation_terms"."version" >= 1),
	CONSTRAINT "invitation_terms_changes" CHECK (("invitation_terms"."version" > 1) = ("invitation_terms"."changes" is not null)),
	CONSTRAINT "invitation_terms_due_after_creation" CHECK ("invitation_terms"."response_due_at" > "invitation_terms"."created_at")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"vacancy_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"sent_by_member_id" uuid NOT NULL,
	"status" text NOT NULL,
	"current_terms_id" uuid,
	"accepted_terms_id" uuid,
	"match_score_id" uuid,
	"policy_id" uuid NOT NULL,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"viewed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_company_vacancy_candidate" UNIQUE("company_id","vacancy_id","candidate_id"),
	CONSTRAINT "invitations_status_values" CHECK ("invitations"."status" in ('sent', 'viewed', 'accepted', 'declined', 'expired', 'withdrawn')),
	CONSTRAINT "invitations_terms" CHECK ("invitations"."purged_at" is not null or "invitations"."current_terms_id" is not null),
	CONSTRAINT "invitations_purged" CHECK ("invitations"."purged_at" is null or ("invitations"."current_terms_id" is null and "invitations"."accepted_terms_id" is null)),
	CONSTRAINT "invitations_accepted_terms" CHECK ("invitations"."status" <> 'accepted' or "invitations"."purged_at" is not null or "invitations"."accepted_terms_id" is not null),
	CONSTRAINT "invitations_reopen_count" CHECK ("invitations"."reopen_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "athlete_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_athlete_id" text NOT NULL,
	"basis_identity_id" uuid,
	"resolution_method" text NOT NULL,
	"status" text NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"unlinked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "athlete_links_source_values" CHECK ("athlete_links"."source" in ('fsp')),
	CONSTRAINT "athlete_links_resolution_method_values" CHECK ("athlete_links"."resolution_method" in ('subject_equals_athlete_id', 'resolved_by_source_api', 'operator_confirmed')),
	CONSTRAINT "athlete_links_status_values" CHECK ("athlete_links"."status" in ('active', 'unlinked')),
	CONSTRAINT "athlete_links_status_fields" CHECK (case when "athlete_links"."status" = 'active'
				then "athlete_links"."unlinked_at" is null and "athlete_links"."basis_identity_id" is not null
				else "athlete_links"."unlinked_at" is not null end)
);
--> statement-breakpoint
CREATE TABLE "email_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid,
	"target_ref" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_tokens_token_hash" UNIQUE("token_hash"),
	CONSTRAINT "email_tokens_purpose_values" CHECK ("email_tokens"."purpose" in ('verify_email', 'reset_password', 'member_invite', 'representative_invite')),
	CONSTRAINT "email_tokens_token_hash_format" CHECK ("email_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_tokens_target" CHECK (case when "email_tokens"."purpose" in ('verify_email', 'reset_password')
				then "email_tokens"."user_id" is not null and "email_tokens"."target_ref" is null
				else "email_tokens"."target_ref" is not null end)
);
--> statement-breakpoint
CREATE TABLE "external_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"link_method" text NOT NULL,
	"last_login_at" timestamp with time zone,
	"profile_claims" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_identities_issuer_subject" UNIQUE("issuer","subject"),
	CONSTRAINT "external_identities_link_method_values" CHECK ("external_identities"."link_method" in ('signup_via_provider', 'linked_by_user'))
);
--> statement-breakpoint
CREATE TABLE "password_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"extra_permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "staff_roles_role_values" CHECK ("staff_roles"."role" in ('operator', 'admin')),
	CONSTRAINT "staff_roles_extra_permissions_values" CHECK ("staff_roles"."extra_permissions" <@ array['audit.read']::text[]),
	CONSTRAINT "staff_roles_extra_permissions_operator" CHECK ("staff_roles"."role" = 'operator' or cardinality("staff_roles"."extra_permissions") = 0),
	CONSTRAINT "staff_roles_revocation" CHECK (("staff_roles"."revoked_at" is null) = ("staff_roles"."revoked_by" is null))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"email_enc" "bytea",
	"email_hmac" text,
	"email_verified_at" timestamp with time zone,
	"display_name" text,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"deletion_requested_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_status_values" CHECK ("users"."status" in ('pending_email', 'active', 'suspended', 'deletion_pending', 'deleted')),
	CONSTRAINT "users_tombstone" CHECK (case when "users"."status" = 'deleted'
				then "users"."email_enc" is null and "users"."email_hmac" is null and "users"."display_name" is null and "users"."deleted_at" is not null
				else "users"."email_enc" is not null and "users"."email_hmac" is not null and "users"."deleted_at" is null end)
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"payload_sha256" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_events_source_event" UNIQUE("source","event_id"),
	CONSTRAINT "inbound_events_payload_sha256_format" CHECK ("inbound_events"."payload_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"type_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"input_version" text NOT NULL,
	"dedup_key" text,
	"status" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" jsonb,
	"created_by" jsonb NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_values" CHECK ("jobs"."status" in ('queued', 'running', 'succeeded', 'discarded_stale', 'failed', 'cancelled')),
	CONSTRAINT "jobs_type_version_positive" CHECK ("jobs"."type_version" >= 1),
	CONSTRAINT "jobs_attempts" CHECK ("jobs"."max_attempts" >= 1 and "jobs"."attempts" >= 0 and "jobs"."attempts" <= "jobs"."max_attempts"),
	CONSTRAINT "jobs_lease" CHECK (("jobs"."status" = 'running') = ("jobs"."lease_owner" is not null) and ("jobs"."lease_owner" is null) = ("jobs"."lease_expires_at" is null)),
	CONSTRAINT "jobs_finished_at" CHECK (("jobs"."status" in ('succeeded', 'discarded_stale', 'failed', 'cancelled')) = ("jobs"."finished_at" is not null)),
	CONSTRAINT "jobs_created_by" CHECK ("jobs"."created_by"->>'kind' in ('user', 'system', 'webhook'))
);
--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"indicator" text NOT NULL,
	"category_key" jsonb NOT NULL,
	"geography" text NOT NULL,
	"currency" text NOT NULL,
	"period" text NOT NULL,
	"tax_base" text NOT NULL,
	"sample_size" integer NOT NULL,
	"median" integer,
	"p25" integer,
	"p75" integer,
	"window_from" date NOT NULL,
	"window_to" date NOT NULL,
	"method" text NOT NULL,
	"estimated" boolean NOT NULL,
	"status" text NOT NULL,
	"provenance" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "market_snapshots_indicator_values" CHECK ("market_snapshots"."indicator" in ('candidate_expectations', 'vacancy_ranges', 'external_reference')),
	CONSTRAINT "market_snapshots_status_values" CHECK ("market_snapshots"."status" in ('ok', 'insufficient_data')),
	CONSTRAINT "market_snapshots_provenance_values" CHECK ("market_snapshots"."provenance" in ('live', 'synthetic', 'mixed')),
	CONSTRAINT "market_snapshots_currency_format" CHECK ("market_snapshots"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "market_snapshots_period_values" CHECK ("market_snapshots"."period" in ('month', 'year', 'hour', 'project')),
	CONSTRAINT "market_snapshots_tax_base_values" CHECK ("market_snapshots"."tax_base" in ('gross', 'net', 'unknown')),
	CONSTRAINT "market_snapshots_sample_size" CHECK ("market_snapshots"."sample_size" >= 0),
	CONSTRAINT "market_snapshots_window" CHECK ("market_snapshots"."window_to" >= "market_snapshots"."window_from"),
	CONSTRAINT "market_snapshots_category_role" CHECK ("market_snapshots"."category_key" ? 'role_key'),
	CONSTRAINT "market_snapshots_values" CHECK (case "market_snapshots"."status"
				when 'ok' then "market_snapshots"."median" is not null and "market_snapshots"."p25" is not null and "market_snapshots"."p75" is not null
					and "market_snapshots"."p25" <= "market_snapshots"."median" and "market_snapshots"."median" <= "market_snapshots"."p75"
				else "market_snapshots"."median" is null and "market_snapshots"."p25" is null and "market_snapshots"."p75" is null end)
);
--> statement-breakpoint
CREATE TABLE "match_scores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vacancy_id" uuid NOT NULL,
	"vacancy_revision" bigint NOT NULL,
	"candidate_id" uuid NOT NULL,
	"candidate_revision" bigint NOT NULL,
	"categorization_run_id" uuid,
	"match_ruleset_id" uuid NOT NULL,
	"embedding_space_id" text,
	"score" numeric(4, 3) NOT NULL,
	"components" jsonb NOT NULL,
	"explanation" jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"job_id" uuid,
	CONSTRAINT "match_scores_snapshot" UNIQUE("vacancy_id","vacancy_revision","candidate_id","candidate_revision","match_ruleset_id"),
	CONSTRAINT "match_scores_score_range" CHECK ("match_scores"."score" >= 0 and "match_scores"."score" <= 1)
);
--> statement-breakpoint
CREATE TABLE "embedding_spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"model_name" text NOT NULL,
	"model_revision" text NOT NULL,
	"dimension" integer NOT NULL,
	"query_prefix" text NOT NULL,
	"document_prefix" text NOT NULL,
	"pooling" text NOT NULL,
	"normalization" text NOT NULL,
	"max_input_tokens" integer NOT NULL,
	"chunking_version" text NOT NULL,
	"status" text NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_spaces_pooling_values" CHECK ("embedding_spaces"."pooling" in ('mean', 'cls', 'last_token', 'provider_default')),
	CONSTRAINT "embedding_spaces_normalization_values" CHECK ("embedding_spaces"."normalization" in ('l2', 'none')),
	CONSTRAINT "embedding_spaces_status_values" CHECK ("embedding_spaces"."status" in ('building', 'active', 'retired')),
	CONSTRAINT "embedding_spaces_dimension" CHECK ("embedding_spaces"."dimension" between 1 and 16000),
	CONSTRAINT "embedding_spaces_max_input_tokens" CHECK ("embedding_spaces"."max_input_tokens" >= 1),
	CONSTRAINT "embedding_spaces_activated_at" CHECK ("embedding_spaces"."status" = 'building' or "embedding_spaces"."activated_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"section" text,
	"input_sha256" text NOT NULL,
	"input_version" text NOT NULL,
	"space_id" text NOT NULL,
	"vector" vector NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embeddings_owner_type_values" CHECK ("embeddings"."owner_type" in ('candidate_section', 'vacancy', 'skill')),
	CONSTRAINT "embeddings_input_sha256_format" CHECK ("embeddings"."input_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "embeddings_section" CHECK (case "embeddings"."owner_type"
				when 'candidate_section' then "embeddings"."section" in ('experience', 'skills', 'summary')
				else "embeddings"."section" is null end)
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_revision" text NOT NULL,
	"dataset_id" text NOT NULL,
	"dataset_size" integer NOT NULL,
	"dataset_provenance" text NOT NULL,
	"split" text NOT NULL,
	"versions" jsonb NOT NULL,
	"processing_mode" text NOT NULL,
	"thresholds" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"report_file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_runs_dataset_provenance_values" CHECK ("eval_runs"."dataset_provenance" in ('synthetic', 'manual_labeled', 'customer')),
	CONSTRAINT "eval_runs_processing_mode_values" CHECK ("eval_runs"."processing_mode" in ('model', 'rules_only', 'partial', 'failed')),
	CONSTRAINT "eval_runs_dataset_size" CHECK ("eval_runs"."dataset_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ml_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"job_id" uuid,
	"input_ref" jsonb NOT NULL,
	"input_sha256" text NOT NULL,
	"input_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"taxonomy_version_id" uuid,
	"model" jsonb,
	"rules_version" text,
	"embedding_space_id" text,
	"processing_mode" text NOT NULL,
	"failure" jsonb,
	"evidence_refs" jsonb,
	"rejected_items" jsonb,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ml_results_job_operation" UNIQUE("job_id","operation"),
	CONSTRAINT "ml_results_operation_values" CHECK ("ml_results"."operation" in ('extract', 'embed', 'rerank', 'explain_text')),
	CONSTRAINT "ml_results_processing_mode_values" CHECK ("ml_results"."processing_mode" in ('model', 'rules_only', 'partial', 'failed')),
	CONSTRAINT "ml_results_input_sha256_format" CHECK ("ml_results"."input_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ml_results_model" CHECK (case "ml_results"."processing_mode"
			when 'model' then "ml_results"."model" is not null
			when 'rules_only' then "ml_results"."model" is null and "ml_results"."rules_version" is not null
			when 'failed' then "ml_results"."failure" is not null
			else true end),
	CONSTRAINT "ml_results_embed_space" CHECK ("ml_results"."operation" <> 'embed' or "ml_results"."embedding_space_id" is not null),
	CONSTRAINT "ml_results_latency" CHECK ("ml_results"."latency_ms" is null or "ml_results"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "search_settings" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"active_embedding_space_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_settings_singleton" CHECK ("search_settings"."singleton")
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"telegram_chat_id_enc" "bytea",
	"telegram_chat_hmac" text,
	"status" text NOT NULL,
	"consent_event_id" uuid,
	"linked_at" timestamp with time zone NOT NULL,
	"unlinked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_channels_kind_values" CHECK ("notification_channels"."kind" in ('email', 'telegram')),
	CONSTRAINT "notification_channels_status_values" CHECK ("notification_channels"."status" in ('active', 'unlinked', 'blocked_by_user')),
	CONSTRAINT "notification_channels_telegram_fields" CHECK (case when "notification_channels"."kind" = 'telegram' and "notification_channels"."status" = 'active'
				then "notification_channels"."telegram_chat_id_enc" is not null and "notification_channels"."telegram_chat_hmac" is not null and "notification_channels"."consent_event_id" is not null
				else "notification_channels"."telegram_chat_id_enc" is null and "notification_channels"."telegram_chat_hmac" is null end),
	CONSTRAINT "notification_channels_email_consent" CHECK ("notification_channels"."kind" = 'telegram' or "notification_channels"."consent_event_id" is null),
	CONSTRAINT "notification_channels_unlinked_at" CHECK (("notification_channels"."status" = 'active') = ("notification_channels"."unlinked_at" is null))
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" text NOT NULL,
	"skip_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_notification_channel" UNIQUE("notification_id","channel_id"),
	CONSTRAINT "notification_deliveries_status_values" CHECK ("notification_deliveries"."status" in ('queued', 'sent', 'failed', 'skipped')),
	CONSTRAINT "notification_deliveries_skip_reason_values" CHECK ("notification_deliveries"."skip_reason" in ('channel_inactive', 'no_consent', 'opted_out', 'recipient_inactive', 'object_not_visible')),
	CONSTRAINT "notification_deliveries_skip_reason" CHECK (("notification_deliveries"."status" = 'skipped') = ("notification_deliveries"."skip_reason" is not null)),
	CONSTRAINT "notification_deliveries_sent" CHECK (("notification_deliveries"."status" = 'sent') = ("notification_deliveries"."sent_at" is not null)),
	CONSTRAINT "notification_deliveries_attempts" CHECK ("notification_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"channels" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_pk" PRIMARY KEY("user_id","category"),
	CONSTRAINT "notification_preferences_category_values" CHECK ("notification_preferences"."category" in ('invitations', 'hiring', 'deadlines', 'disputes', 'account')),
	CONSTRAINT "notification_preferences_channels" CHECK ("notification_preferences"."channels" <@ array['email', 'telegram']::text[]),
	CONSTRAINT "notification_preferences_account_email" CHECK ("notification_preferences"."category" <> 'account' or "notification_preferences"."channels" @> array['email']::text[])
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid NOT NULL,
	"dedup_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedup_key" UNIQUE("dedup_key"),
	CONSTRAINT "notifications_category_values" CHECK ("notifications"."category" in ('invitations', 'hiring', 'deadlines', 'disputes', 'account'))
);
--> statement-breakpoint
CREATE TABLE "telegram_link_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_link_tokens_token_hash" UNIQUE("token_hash"),
	CONSTRAINT "telegram_link_tokens_token_hash_format" CHECK ("telegram_link_tokens"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "product_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"params" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_policies_kind_version" UNIQUE("kind","version"),
	CONSTRAINT "product_policies_kind_values" CHECK ("product_policies"."kind" in ('invitation_policy', 'hiring_policy', 'notification_policy', 'minor_policy', 'catalog_policy', 'market_policy', 'sourcing_policy', 'assessment_policy', 'retention_policy')),
	CONSTRAINT "product_policies_version_positive" CHECK ("product_policies"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "categorization_rulesets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"params" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categorization_rulesets_version" UNIQUE("version"),
	CONSTRAINT "categorization_rulesets_version_positive" CHECK ("categorization_rulesets"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "fsp_level_rules" (
	"taxonomy_version_id" uuid NOT NULL,
	"level" text NOT NULL,
	"criteria" jsonb NOT NULL,
	CONSTRAINT "fsp_level_rules_pk" PRIMARY KEY("taxonomy_version_id","level"),
	CONSTRAINT "fsp_level_rules_level_values" CHECK ("fsp_level_rules"."level" in ('L1', 'L2', 'L3', 'L4', 'L5'))
);
--> statement-breakpoint
CREATE TABLE "fsp_projection_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"discipline" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_key" text NOT NULL,
	"weight" numeric(4, 3) NOT NULL,
	"attestation" text NOT NULL,
	"requires_specialization" text,
	"applies_to" text NOT NULL,
	CONSTRAINT "fsp_projection_rules_target" UNIQUE NULLS NOT DISTINCT("taxonomy_version_id","discipline","target_kind","target_key","requires_specialization","applies_to"),
	CONSTRAINT "fsp_projection_rules_target_kind_values" CHECK ("fsp_projection_rules"."target_kind" in ('skill', 'role', 'marker')),
	CONSTRAINT "fsp_projection_rules_attestation_values" CHECK ("fsp_projection_rules"."attestation" in ('direct', 'derived')),
	CONSTRAINT "fsp_projection_rules_applies_to_values" CHECK ("fsp_projection_rules"."applies_to" in ('individual', 'team', 'any')),
	CONSTRAINT "fsp_projection_rules_weight_range" CHECK ("fsp_projection_rules"."weight" >= 0 and "fsp_projection_rules"."weight" <= 1),
	CONSTRAINT "fsp_projection_rules_team_not_direct" CHECK ("fsp_projection_rules"."attestation" = 'derived' or "fsp_projection_rules"."applies_to" = 'individual')
);
--> statement-breakpoint
CREATE TABLE "fsp_strength_params" (
	"taxonomy_version_id" uuid PRIMARY KEY NOT NULL,
	"evsk_norm" jsonb NOT NULL,
	"rank_strength" jsonb NOT NULL,
	"format_factors" jsonb NOT NULL,
	"unknown_role_factor" numeric(4, 3) NOT NULL,
	"recency_half_life_years" numeric(5, 2) NOT NULL,
	CONSTRAINT "fsp_strength_params_unknown_role_factor" CHECK ("fsp_strength_params"."unknown_role_factor" >= 0 and "fsp_strength_params"."unknown_role_factor" <= 1),
	CONSTRAINT "fsp_strength_params_half_life" CHECK ("fsp_strength_params"."recency_half_life_years" > 0)
);
--> statement-breakpoint
CREATE TABLE "grades" (
	"taxonomy_version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"ordinal" integer NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "grades_pk" PRIMARY KEY("taxonomy_version_id","key"),
	CONSTRAINT "grades_version_ordinal" UNIQUE("taxonomy_version_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "match_rulesets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"params" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_rulesets_version" UNIQUE("version"),
	CONSTRAINT "match_rulesets_version_positive" CHECK ("match_rulesets"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "receipt_templates" (
	"taxonomy_version_id" uuid NOT NULL,
	"source" text NOT NULL,
	"fact_type" text NOT NULL,
	"asserts" jsonb NOT NULL,
	"does_not_assert" text[] NOT NULL,
	CONSTRAINT "receipt_templates_pk" PRIMARY KEY("taxonomy_version_id","source","fact_type")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"taxonomy_version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"family" text NOT NULL,
	"name_ru" text NOT NULL,
	"core_skill_groups" jsonb NOT NULL,
	"typical_skills" text[] NOT NULL,
	"hh_role_id" text,
	"habr_spec" text,
	"prof_standard" text,
	CONSTRAINT "roles_pk" PRIMARY KEY("taxonomy_version_id","key")
);
--> statement-breakpoint
CREATE TABLE "salary_references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"source" text NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"role_key" text NOT NULL,
	"grade_key" text,
	"skill_key" text,
	"median" integer,
	"p25" integer,
	"p75" integer,
	"sample_size" integer NOT NULL,
	"currency" text NOT NULL,
	"period" text NOT NULL,
	"tax_base" text NOT NULL,
	"geography" text NOT NULL,
	"method" text NOT NULL,
	CONSTRAINT "salary_references_currency_format" CHECK ("salary_references"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "salary_references_period_values" CHECK ("salary_references"."period" in ('month', 'year', 'hour', 'project')),
	CONSTRAINT "salary_references_tax_base_values" CHECK ("salary_references"."tax_base" in ('gross', 'net', 'unknown')),
	CONSTRAINT "salary_references_sample_size" CHECK ("salary_references"."sample_size" >= 0),
	CONSTRAINT "salary_references_quantiles" CHECK (("salary_references"."p25" is null or "salary_references"."median" is null or "salary_references"."p25" <= "salary_references"."median")
				and ("salary_references"."median" is null or "salary_references"."p75" is null or "salary_references"."median" <= "salary_references"."p75"))
);
--> statement-breakpoint
CREATE TABLE "skill_aliases" (
	"taxonomy_version_id" uuid NOT NULL,
	"alias_normalized" text NOT NULL,
	"skill_key" text NOT NULL,
	CONSTRAINT "skill_aliases_pk" PRIMARY KEY("taxonomy_version_id","alias_normalized")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"taxonomy_version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"parent_key" text,
	"name" text NOT NULL,
	"hh_id" text,
	"habr_id" text,
	"so_tag" text,
	CONSTRAINT "skills_pk" PRIMARY KEY("taxonomy_version_id","key"),
	CONSTRAINT "skills_kind_values" CHECK ("skills"."kind" in ('language', 'framework', 'library', 'runtime', 'platform', 'database', 'tool', 'practice', 'domain')),
	CONSTRAINT "skills_parent_not_self" CHECK ("skills"."parent_key" is distinct from "skills"."key")
);
--> statement-breakpoint
CREATE TABLE "taxonomy_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"status" text NOT NULL,
	"published_at" timestamp with time zone,
	"sources" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "taxonomy_versions_label" UNIQUE("label"),
	CONSTRAINT "taxonomy_versions_status_values" CHECK ("taxonomy_versions"."status" in ('draft', 'published', 'retired')),
	CONSTRAINT "taxonomy_versions_published_at" CHECK (("taxonomy_versions"."status" = 'draft') = ("taxonomy_versions"."published_at" is null))
);
--> statement-breakpoint
CREATE TABLE "unknown_skill_mentions" (
	"raw_normalized" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unknown_skill_mentions_review_status_values" CHECK ("unknown_skill_mentions"."review_status" in ('pending', 'added', 'rejected')),
	CONSTRAINT "unknown_skill_mentions_count_positive" CHECK ("unknown_skill_mentions"."count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "work_formats" (
	"taxonomy_version_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "work_formats_pk" PRIMARY KEY("taxonomy_version_id","dimension","key")
);
--> statement-breakpoint
CREATE TABLE "vacancies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin" text NOT NULL,
	"company_id" uuid,
	"created_by_member_id" uuid,
	"external_org" jsonb,
	"claimed_company_id" uuid,
	"derived_from_vacancy_id" uuid,
	"superseded_by_vacancy_id" uuid,
	"revision" bigint DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"taxonomy_version_id" uuid NOT NULL,
	"role_key" text,
	"grade_min" text,
	"grade_max" text,
	"grade_basis" text NOT NULL,
	"required_skill_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"nice_skill_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"work_format" text,
	"employment_form" text,
	"contract_types" text[],
	"city_id" text,
	"timezone_overlap_hours" integer,
	"salary_min" integer,
	"salary_max" integer,
	"salary_currency" text,
	"salary_period" text,
	"salary_tax_base" text,
	"min_age" integer,
	"minor_terms_acceptance_id" uuid,
	"terms_conflict" boolean DEFAULT false NOT NULL,
	"pool_count" integer,
	"pool_counted_at" timestamp with time zone,
	"draft_ml_result_id" uuid,
	"text_check" jsonb NOT NULL,
	"status" text NOT NULL,
	"published_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"seed_batch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vacancies_origin_values" CHECK ("vacancies"."origin" in ('own', 'external')),
	CONSTRAINT "vacancies_grade_basis_values" CHECK ("vacancies"."grade_basis" in ('stated', 'inferred', 'unknown')),
	CONSTRAINT "vacancies_salary_bounds" CHECK (("vacancies"."salary_min" is null or "vacancies"."salary_min" >= 0) and ("vacancies"."salary_max" is null or "vacancies"."salary_max" >= 0)
				and ("vacancies"."salary_min" is null or "vacancies"."salary_max" is null or "vacancies"."salary_min" <= "vacancies"."salary_max")),
	CONSTRAINT "vacancies_salary_terms" CHECK (("vacancies"."salary_min" is null and "vacancies"."salary_max" is null)
				or ("vacancies"."salary_currency" is not null and "vacancies"."salary_period" is not null and "vacancies"."salary_tax_base" is not null)),
	CONSTRAINT "vacancies_salary_currency_format" CHECK ("vacancies"."salary_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "vacancies_salary_period_values" CHECK ("vacancies"."salary_period" in ('month', 'year', 'hour', 'project')),
	CONSTRAINT "vacancies_salary_tax_base_values" CHECK ("vacancies"."salary_tax_base" in ('gross', 'net', 'unknown')),
	CONSTRAINT "vacancies_status_by_origin" CHECK (case "vacancies"."origin"
				when 'own' then "vacancies"."status" in ('draft', 'pending_moderation', 'published', 'paused', 'closed')
				else "vacancies"."status" in ('active', 'stale', 'closed', 'hidden') end),
	CONSTRAINT "vacancies_own_fields" CHECK ("vacancies"."origin" <> 'own' or ("vacancies"."company_id" is not null and "vacancies"."created_by_member_id" is not null
				and "vacancies"."description" is not null and "vacancies"."role_key" is not null
				and "vacancies"."grade_min" is not null and "vacancies"."grade_max" is not null and "vacancies"."grade_basis" = 'stated'
				and "vacancies"."work_format" is not null and "vacancies"."employment_form" is not null and "vacancies"."contract_types" is not null
				and "vacancies"."salary_min" is not null and "vacancies"."salary_max" is not null and "vacancies"."salary_tax_base" in ('gross', 'net')
				and "vacancies"."external_org" is null and "vacancies"."claimed_company_id" is null and "vacancies"."superseded_by_vacancy_id" is null
				and "vacancies"."terms_conflict" = false)),
	CONSTRAINT "vacancies_external_fields" CHECK ("vacancies"."origin" <> 'external' or ("vacancies"."company_id" is null and "vacancies"."created_by_member_id" is null
				and "vacancies"."external_org" is not null and "vacancies"."derived_from_vacancy_id" is null
				and "vacancies"."min_age" is null and "vacancies"."minor_terms_acceptance_id" is null and "vacancies"."draft_ml_result_id" is null)),
	CONSTRAINT "vacancies_grade_pair" CHECK (("vacancies"."grade_min" is null) = ("vacancies"."grade_max" is null)),
	CONSTRAINT "vacancies_grade_basis" CHECK (("vacancies"."grade_basis" = 'unknown') = ("vacancies"."grade_min" is null)),
	CONSTRAINT "vacancies_min_age" CHECK ("vacancies"."min_age" is null or ("vacancies"."min_age" in (14, 15, 16) and "vacancies"."minor_terms_acceptance_id" is not null)),
	CONSTRAINT "vacancies_revision_positive" CHECK ("vacancies"."revision" >= 1),
	CONSTRAINT "vacancies_published_at" CHECK ("vacancies"."status" <> 'published' or "vacancies"."published_at" is not null),
	CONSTRAINT "vacancies_closed_at" CHECK (("vacancies"."status" = 'closed') = ("vacancies"."closed_at" is not null)),
	CONSTRAINT "vacancies_pool_count" CHECK (("vacancies"."pool_count" is null) = ("vacancies"."pool_counted_at" is null) and ("vacancies"."pool_count" is null or "vacancies"."pool_count" >= 0))
);
--> statement-breakpoint
CREATE TABLE "vacancy_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vacancy_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"match_evidence" jsonb NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vacancy_claims_status_values" CHECK ("vacancy_claims"."status" in ('awaiting_company_verification', 'pending_review', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "vacancy_claims_rejection_reason" CHECK ("vacancy_claims"."status" <> 'rejected' or "vacancy_claims"."reason" is not null),
	CONSTRAINT "vacancy_claims_operator_decision" CHECK ("vacancy_claims"."status" <> 'approved' or ("vacancy_claims"."decided_by" is not null and "vacancy_claims"."decided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "vacancy_import_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"adapter_version" text NOT NULL,
	"job_id" uuid,
	"mode" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"completeness" text,
	"incomplete_reason" text,
	"cursor_state" jsonb,
	"counts" jsonb NOT NULL,
	CONSTRAINT "vacancy_import_runs_mode_values" CHECK ("vacancy_import_runs"."mode" in ('full', 'incremental', 'check')),
	CONSTRAINT "vacancy_import_runs_status_values" CHECK ("vacancy_import_runs"."status" in ('running', 'succeeded', 'failed')),
	CONSTRAINT "vacancy_import_runs_completeness_values" CHECK ("vacancy_import_runs"."completeness" in ('complete', 'partial')),
	CONSTRAINT "vacancy_import_runs_finish" CHECK (("vacancy_import_runs"."status" = 'running') = ("vacancy_import_runs"."finished_at" is null) and ("vacancy_import_runs"."status" = 'running') = ("vacancy_import_runs"."completeness" is null)),
	CONSTRAINT "vacancy_import_runs_incomplete_reason" CHECK (("vacancy_import_runs"."completeness" = 'partial') = ("vacancy_import_runs"."incomplete_reason" is not null)),
	CONSTRAINT "vacancy_import_runs_complete_only_full" CHECK ("vacancy_import_runs"."completeness" is distinct from 'complete' or "vacancy_import_runs"."mode" = 'full')
);
--> statement-breakpoint
CREATE TABLE "vacancy_postings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vacancy_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"organization" jsonb NOT NULL,
	"title" text NOT NULL,
	"original_terms" jsonb NOT NULL,
	"raw_sha256" text NOT NULL,
	"normalized" jsonb NOT NULL,
	"normalization_version" text NOT NULL,
	"source_published_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"first_fetched_at" timestamp with time zone NOT NULL,
	"last_fetched_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone NOT NULL,
	"freshness" text NOT NULL,
	"gone_at" timestamp with time zone,
	"dedup" jsonb NOT NULL,
	"last_import_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vacancy_postings_source_external" UNIQUE("source","external_id"),
	CONSTRAINT "vacancy_postings_freshness_values" CHECK ("vacancy_postings"."freshness" in ('active', 'gone', 'unknown')),
	CONSTRAINT "vacancy_postings_raw_sha256_format" CHECK ("vacancy_postings"."raw_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vacancy_postings_gone_at" CHECK (("vacancy_postings"."freshness" = 'gone') = ("vacancy_postings"."gone_at" is not null)),
	CONSTRAINT "vacancy_postings_dedup_method" CHECK ("vacancy_postings"."dedup"->>'method' in ('exact', 'fingerprint', 'fuzzy', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "vacancy_sources" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"site_url" text NOT NULL,
	"adapter_version" text NOT NULL,
	"terms" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"schedule" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vacancy_sources_terms_status" CHECK ("vacancy_sources"."terms"->>'status' in ('unchecked', 'allowed', 'restricted', 'forbidden')),
	CONSTRAINT "vacancy_sources_forbidden_disabled" CHECK (not ("vacancy_sources"."enabled" and "vacancy_sources"."terms"->>'status' = 'forbidden'))
);
--> statement-breakpoint
ALTER TABLE "assessment_artifacts" ADD CONSTRAINT "assessment_artifacts_attempt_id_assessment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."assessment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_artifacts" ADD CONSTRAINT "assessment_artifacts_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_version_id_assessment_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."assessment_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_annulled_by_users_id_fk" FOREIGN KEY ("annulled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_attempt_id_assessment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."assessment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_supersedes_score_id_assessment_scores_id_fk" FOREIGN KEY ("supersedes_score_id") REFERENCES "public"."assessment_scores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_versions" ADD CONSTRAINT "assessment_versions_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_company_blocks" ADD CONSTRAINT "candidate_company_blocks_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_company_blocks" ADD CONSTRAINT "candidate_company_blocks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_birth_date_verified_by_users_id_fk" FOREIGN KEY ("birth_date_verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_profiles" ADD CONSTRAINT "external_profiles_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_runs" ADD CONSTRAINT "categorization_runs_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_runs" ADD CONSTRAINT "categorization_runs_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_runs" ADD CONSTRAINT "categorization_runs_ruleset_id_categorization_rulesets_id_fk" FOREIGN KEY ("ruleset_id") REFERENCES "public"."categorization_rulesets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_runs" ADD CONSTRAINT "categorization_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_runs" ADD CONSTRAINT "categorization_runs_override_by_users_id_fk" FOREIGN KEY ("override_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_assignments" ADD CONSTRAINT "category_assignments_run_id_categorization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."categorization_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_disputes" ADD CONSTRAINT "category_disputes_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_disputes" ADD CONSTRAINT "category_disputes_run_id_categorization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."categorization_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_disputes" ADD CONSTRAINT "category_disputes_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_disputes" ADD CONSTRAINT "category_disputes_resulting_run_id_categorization_runs_id_fk" FOREIGN KEY ("resulting_run_id") REFERENCES "public"."categorization_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fsp_level_assignments" ADD CONSTRAINT "fsp_level_assignments_run_id_categorization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."categorization_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_member_id_company_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_minor_terms_document_id_legal_documents_id_fk" FOREIGN KEY ("minor_terms_document_id") REFERENCES "public"."legal_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_verifications" ADD CONSTRAINT "company_verifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_verifications" ADD CONSTRAINT "company_verifications_applicant_member_id_company_members_id_fk" FOREIGN KEY ("applicant_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_verifications" ADD CONSTRAINT "company_verifications_authority_evidence_file_id_files_id_fk" FOREIGN KEY ("authority_evidence_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_verifications" ADD CONSTRAINT "company_verifications_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_partnerships" ADD CONSTRAINT "competition_partnerships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_partnerships" ADD CONSTRAINT "competition_partnerships_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authority_checks" ADD CONSTRAINT "authority_checks_representation_id_representations_id_fk" FOREIGN KEY ("representation_id") REFERENCES "public"."representations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authority_checks" ADD CONSTRAINT "authority_checks_evidence_file_id_files_id_fk" FOREIGN KEY ("evidence_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authority_checks" ADD CONSTRAINT "authority_checks_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_subject_candidate_id_candidates_id_fk" FOREIGN KEY ("subject_candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_document_id_legal_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."legal_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_signer_user_id_users_id_fk" FOREIGN KEY ("signer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_representation_id_representations_id_fk" FOREIGN KEY ("representation_id") REFERENCES "public"."representations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_scope_company_id_companies_id_fk" FOREIGN KEY ("scope_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_scope_invitation_id_invitations_id_fk" FOREIGN KEY ("scope_invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_recipient_member_id_company_members_id_fk" FOREIGN KEY ("recipient_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_consent_event_id_consent_events_id_fk" FOREIGN KEY ("consent_event_id") REFERENCES "public"."consent_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acceptances" ADD CONSTRAINT "document_acceptances_document_id_legal_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."legal_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acceptances" ADD CONSTRAINT "document_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acceptances" ADD CONSTRAINT "document_acceptances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_pd_operator_id_pd_operators_id_fk" FOREIGN KEY ("pd_operator_id") REFERENCES "public"."pd_operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "representations" ADD CONSTRAINT "representations_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "representations" ADD CONSTRAINT "representations_representative_id_legal_representatives_id_fk" FOREIGN KEY ("representative_id") REFERENCES "public"."legal_representatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_resume_document_id_resume_documents_id_fk" FOREIGN KEY ("resume_document_id") REFERENCES "public"."resume_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_documents" ADD CONSTRAINT "resume_documents_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_documents" ADD CONSTRAINT "resume_documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_fact_id_source_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."source_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_experience_entry_id_experience_entries_id_fk" FOREIGN KEY ("experience_entry_id") REFERENCES "public"."experience_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_ml_result_id_ml_results_id_fk" FOREIGN KEY ("ml_result_id") REFERENCES "public"."ml_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_entries" ADD CONSTRAINT "experience_entries_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_entries" ADD CONSTRAINT "experience_entries_fact_id_source_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."source_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_inferences" ADD CONSTRAINT "skill_inferences_run_id_categorization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."categorization_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_inferences" ADD CONSTRAINT "skill_inferences_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_facts" ADD CONSTRAINT "source_facts_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_facts" ADD CONSTRAINT "source_facts_consent_event_id_consent_events_id_fk" FOREIGN KEY ("consent_event_id") REFERENCES "public"."consent_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_receipts" ADD CONSTRAINT "verification_receipts_fact_id_source_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."source_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_receipts" ADD CONSTRAINT "verification_receipts_audience_company_id_companies_id_fk" FOREIGN KEY ("audience_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_processes" ADD CONSTRAINT "hiring_processes_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_processes" ADD CONSTRAINT "hiring_processes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_processes" ADD CONSTRAINT "hiring_processes_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_processes" ADD CONSTRAINT "hiring_processes_policy_id_product_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."product_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_reports" ADD CONSTRAINT "hiring_reports_process_id_hiring_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."hiring_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_reports" ADD CONSTRAINT "hiring_reports_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_reports" ADD CONSTRAINT "hiring_reports_supersedes_report_id_hiring_reports_id_fk" FOREIGN KEY ("supersedes_report_id") REFERENCES "public"."hiring_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_responses" ADD CONSTRAINT "invitation_responses_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_responses" ADD CONSTRAINT "invitation_responses_terms_id_invitation_terms_id_fk" FOREIGN KEY ("terms_id") REFERENCES "public"."invitation_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_responses" ADD CONSTRAINT "invitation_responses_consent_event_id_consent_events_id_fk" FOREIGN KEY ("consent_event_id") REFERENCES "public"."consent_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD CONSTRAINT "invitation_terms_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_terms" ADD CONSTRAINT "invitation_terms_created_by_member_id_company_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_vacancy_id_vacancies_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_sent_by_member_id_company_members_id_fk" FOREIGN KEY ("sent_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_current_terms_id_invitation_terms_id_fk" FOREIGN KEY ("current_terms_id") REFERENCES "public"."invitation_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_terms_id_invitation_terms_id_fk" FOREIGN KEY ("accepted_terms_id") REFERENCES "public"."invitation_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_match_score_id_match_scores_id_fk" FOREIGN KEY ("match_score_id") REFERENCES "public"."match_scores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_policy_id_product_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."product_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_links" ADD CONSTRAINT "athlete_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_links" ADD CONSTRAINT "athlete_links_basis_identity_id_external_identities_id_fk" FOREIGN KEY ("basis_identity_id") REFERENCES "public"."external_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_credentials" ADD CONSTRAINT "password_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_vacancy_id_vacancies_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_categorization_run_id_categorization_runs_id_fk" FOREIGN KEY ("categorization_run_id") REFERENCES "public"."categorization_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_match_ruleset_id_match_rulesets_id_fk" FOREIGN KEY ("match_ruleset_id") REFERENCES "public"."match_rulesets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_space_id_embedding_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_report_file_id_files_id_fk" FOREIGN KEY ("report_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_results" ADD CONSTRAINT "ml_results_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_results" ADD CONSTRAINT "ml_results_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_results" ADD CONSTRAINT "ml_results_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_settings" ADD CONSTRAINT "search_settings_active_embedding_space_id_embedding_spaces_id_fk" FOREIGN KEY ("active_embedding_space_id") REFERENCES "public"."embedding_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_consent_event_id_consent_events_id_fk" FOREIGN KEY ("consent_event_id") REFERENCES "public"."consent_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_tokens" ADD CONSTRAINT "telegram_link_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_rulesets" ADD CONSTRAINT "categorization_rulesets_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fsp_level_rules" ADD CONSTRAINT "fsp_level_rules_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fsp_projection_rules" ADD CONSTRAINT "fsp_projection_rules_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fsp_strength_params" ADD CONSTRAINT "fsp_strength_params_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_rulesets" ADD CONSTRAINT "match_rulesets_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_templates" ADD CONSTRAINT "receipt_templates_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_references" ADD CONSTRAINT "salary_references_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_aliases" ADD CONSTRAINT "skill_aliases_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_formats" ADD CONSTRAINT "work_formats_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_created_by_member_id_company_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_claimed_company_id_companies_id_fk" FOREIGN KEY ("claimed_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_derived_from_vacancy_id_vacancies_id_fk" FOREIGN KEY ("derived_from_vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_superseded_by_vacancy_id_vacancies_id_fk" FOREIGN KEY ("superseded_by_vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_minor_terms_acceptance_id_document_acceptances_id_fk" FOREIGN KEY ("minor_terms_acceptance_id") REFERENCES "public"."document_acceptances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_draft_ml_result_id_ml_results_id_fk" FOREIGN KEY ("draft_ml_result_id") REFERENCES "public"."ml_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_claims" ADD CONSTRAINT "vacancy_claims_vacancy_id_vacancies_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_claims" ADD CONSTRAINT "vacancy_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_claims" ADD CONSTRAINT "vacancy_claims_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_claims" ADD CONSTRAINT "vacancy_claims_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_import_runs" ADD CONSTRAINT "vacancy_import_runs_source_vacancy_sources_key_fk" FOREIGN KEY ("source") REFERENCES "public"."vacancy_sources"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_import_runs" ADD CONSTRAINT "vacancy_import_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_postings" ADD CONSTRAINT "vacancy_postings_vacancy_id_vacancies_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_postings" ADD CONSTRAINT "vacancy_postings_source_vacancy_sources_key_fk" FOREIGN KEY ("source") REFERENCES "public"."vacancy_sources"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_postings" ADD CONSTRAINT "vacancy_postings_last_import_run_id_vacancy_import_runs_id_fk" FOREIGN KEY ("last_import_run_id") REFERENCES "public"."vacancy_import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_attempts_candidate" ON "assessment_attempts" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "assessment_scores_attempt" ON "assessment_scores" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "audit_events_subject" ON "audit_events" USING btree ("subject_candidate_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_action" ON "audit_events" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE INDEX "external_profiles_candidate" ON "external_profiles" USING btree ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "categorization_runs_published" ON "categorization_runs" USING btree ("candidate_id") WHERE "categorization_runs"."status" = 'published';--> statement-breakpoint
CREATE INDEX "categorization_runs_candidate" ON "categorization_runs" USING btree ("candidate_id","computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "category_assignments_one_primary" ON "category_assignments" USING btree ("run_id") WHERE "category_assignments"."rank" = 'primary';--> statement-breakpoint
CREATE INDEX "category_assignments_run" ON "category_assignments" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "category_disputes_candidate" ON "category_disputes" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "category_disputes_open_due" ON "category_disputes" USING btree ("due_at") WHERE "category_disputes"."status" in ('open', 'in_review');--> statement-breakpoint
CREATE INDEX "api_keys_member" ON "api_keys" USING btree ("created_by_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_inn_not_rejected" ON "companies" USING btree ("inn") WHERE "companies"."status" <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "company_members_active_user" ON "company_members" USING btree ("company_id","user_id") WHERE "company_members"."status" = 'active';--> statement-breakpoint
CREATE INDEX "company_members_user" ON "company_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "company_verifications_company" ON "company_verifications" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "competition_partnerships_competition" ON "competition_partnerships" USING btree ("competition_source","competition_ref");--> statement-breakpoint
CREATE INDEX "competition_partnerships_company" ON "competition_partnerships" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "authority_checks_representation" ON "authority_checks" USING btree ("representation_id");--> statement-breakpoint
CREATE INDEX "consent_events_subject_kind" ON "consent_events" USING btree ("subject_candidate_id","kind","occurred_at");--> statement-breakpoint
CREATE INDEX "consent_events_representation" ON "consent_events" USING btree ("representation_id");--> statement-breakpoint
CREATE INDEX "disclosures_candidate" ON "disclosures" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "disclosures_invitation" ON "disclosures" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "document_acceptances_user" ON "document_acceptances" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "document_acceptances_company" ON "document_acceptances" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "legal_representatives_email_hmac" ON "legal_representatives" USING btree ("email_hmac");--> statement-breakpoint
CREATE INDEX "representations_candidate" ON "representations" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "files_owner" ON "files" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resume_documents_current" ON "resume_documents" USING btree ("candidate_id") WHERE "resume_documents"."is_current";--> statement-breakpoint
CREATE INDEX "claims_candidate_status" ON "claims" USING btree ("candidate_id","status");--> statement-breakpoint
CREATE INDEX "claims_fact" ON "claims" USING btree ("fact_id");--> statement-breakpoint
CREATE INDEX "claims_experience_entry" ON "claims" USING btree ("experience_entry_id");--> statement-breakpoint
CREATE INDEX "experience_entries_candidate" ON "experience_entries" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "experience_entries_fact" ON "experience_entries" USING btree ("fact_id");--> statement-breakpoint
CREATE INDEX "skill_inferences_candidate" ON "skill_inferences" USING btree ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_facts_active_record" ON "source_facts" USING btree ("candidate_id","source_record_ref") WHERE "source_facts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "source_facts_candidate_status" ON "source_facts" USING btree ("candidate_id","status");--> statement-breakpoint
CREATE INDEX "source_facts_ownership_ref" ON "source_facts" USING btree ("ownership_ref");--> statement-breakpoint
CREATE INDEX "hiring_processes_candidate" ON "hiring_processes" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "hiring_processes_company" ON "hiring_processes" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "hiring_reports_process" ON "hiring_reports" USING btree ("process_id");--> statement-breakpoint
CREATE INDEX "invitation_responses_invitation" ON "invitation_responses" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "invitations_candidate" ON "invitations" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "invitations_company" ON "invitations" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_links_active_athlete" ON "athlete_links" USING btree ("source","source_athlete_id") WHERE "athlete_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "athlete_links_user" ON "athlete_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "external_identities_user" ON "external_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_roles_active" ON "staff_roles" USING btree ("user_id","role") WHERE "staff_roles"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_hmac_live" ON "users" USING btree ("email_hmac") WHERE "users"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX "inbound_events_received" ON "inbound_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedup_queued" ON "jobs" USING btree ("dedup_key") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedup_running" ON "jobs" USING btree ("dedup_key") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_capture" ON "jobs" USING btree ("priority" DESC NULLS LAST,"run_after") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_expired_leases" ON "jobs" USING btree ("lease_expires_at") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "market_snapshots_lookup" ON "market_snapshots" USING btree ("indicator","geography","computed_at");--> statement-breakpoint
CREATE INDEX "match_scores_candidate" ON "match_scores" USING btree ("candidate_id","candidate_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_spaces_single_active" ON "embedding_spaces" USING btree ("status") WHERE "embedding_spaces"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_owner_space" ON "embeddings" USING btree ("space_id","owner_type","owner_id",coalesce("section", ''));--> statement-breakpoint
CREATE INDEX "embeddings_space" ON "embeddings" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_active_chat" ON "notification_channels" USING btree ("telegram_chat_hmac") WHERE "notification_channels"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_active_kind" ON "notification_channels" USING btree ("user_id","kind") WHERE "notification_channels"."status" = 'active';--> statement-breakpoint
CREATE INDEX "notifications_user_unread" ON "notifications" USING btree ("user_id","created_at") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "vacancies_company" ON "vacancies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "vacancies_origin_status" ON "vacancies" USING btree ("origin","status");--> statement-breakpoint
CREATE UNIQUE INDEX "vacancy_claims_one_approved" ON "vacancy_claims" USING btree ("vacancy_id") WHERE "vacancy_claims"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "vacancy_claims_company" ON "vacancy_claims" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "vacancy_import_runs_source" ON "vacancy_import_runs" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "vacancy_postings_vacancy" ON "vacancy_postings" USING btree ("vacancy_id");