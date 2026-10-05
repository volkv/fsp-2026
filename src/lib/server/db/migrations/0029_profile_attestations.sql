CREATE TABLE "category_attestations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"candidate_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"bank_release_id" text NOT NULL,
	"statement" jsonb NOT NULL,
	"statement_sha256" text NOT NULL,
	"signature" text NOT NULL,
	"signing_key_id" text NOT NULL,
	"holder_nonce" "bytea" NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	CONSTRAINT "category_attestations_handle" UNIQUE("handle"),
	CONSTRAINT "category_attestations_statement_sha256_format" CHECK ("category_attestations"."statement_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "category_attestations_handle_format" CHECK ("category_attestations"."handle" ~ '^[a-z2-7]{26}$'),
	CONSTRAINT "category_attestations_nonce_length" CHECK (octet_length("category_attestations"."holder_nonce") = 32)
);
--> statement-breakpoint
CREATE TABLE "profile_experience_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"position_title" text NOT NULL,
	"organization_name" text,
	"role_key" text,
	"period_from" date NOT NULL,
	"period_to" date,
	"is_current" boolean NOT NULL,
	"skill_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_experience_entries_title_length" CHECK (char_length("profile_experience_entries"."position_title") between 1 and 200),
	CONSTRAINT "profile_experience_entries_organization_length" CHECK (char_length("profile_experience_entries"."organization_name") between 1 and 200),
	CONSTRAINT "profile_experience_entries_description_length" CHECK (char_length("profile_experience_entries"."description") between 1 and 1000),
	CONSTRAINT "profile_experience_entries_period" CHECK (("profile_experience_entries"."is_current") = ("profile_experience_entries"."period_to" is null)),
	CONSTRAINT "profile_experience_entries_order" CHECK ("profile_experience_entries"."period_to" is null or "profile_experience_entries"."period_to" >= "profile_experience_entries"."period_from"),
	CONSTRAINT "profile_experience_entries_skills" CHECK (cardinality("profile_experience_entries"."skill_keys") <= 30)
);
--> statement-breakpoint
CREATE TABLE "profile_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value_enc" "bytea",
	"skill_key" text,
	"quote" jsonb NOT NULL,
	"status" text NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_suggestions_field_values" CHECK ("profile_suggestions"."field" in ('full_name', 'phone', 'email', 'telegram', 'soft_skill')),
	CONSTRAINT "profile_suggestions_status_values" CHECK ("profile_suggestions"."status" in ('pending', 'accepted', 'rejected')),
	CONSTRAINT "profile_suggestions_value" CHECK (case when "profile_suggestions"."field" = 'soft_skill' then "profile_suggestions"."skill_key" is not null and "profile_suggestions"."value_enc" is null
				else "profile_suggestions"."value_enc" is not null and "profile_suggestions"."skill_key" is null end),
	CONSTRAINT "profile_suggestions_decided" CHECK (("profile_suggestions"."status" = 'pending') = ("profile_suggestions"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "candidates" DROP CONSTRAINT "candidates_tombstone";--> statement-breakpoint
ALTER TABLE "consent_events" DROP CONSTRAINT "consent_events_scope_fields";--> statement-breakpoint
ALTER TABLE "disclosures" DROP CONSTRAINT "disclosures_fields";--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "telegram_enc" "bytea";--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "soft_skill_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "category_attestations" ADD CONSTRAINT "category_attestations_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_attestations" ADD CONSTRAINT "category_attestations_category_id_candidate_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."candidate_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_attestations" ADD CONSTRAINT "category_attestations_decision_id_grade_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."grade_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_experience_entries" ADD CONSTRAINT "profile_experience_entries_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_suggestions" ADD CONSTRAINT "profile_suggestions_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_suggestions" ADD CONSTRAINT "profile_suggestions_extraction_id_document_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_attestations_category" ON "category_attestations" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "category_attestations_candidate" ON "category_attestations" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "profile_experience_entries_candidate" ON "profile_experience_entries" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "profile_suggestions_candidate" ON "profile_suggestions" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "profile_suggestions_extraction" ON "profile_suggestions" USING btree ("extraction_id");--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_soft_skills" CHECK (cardinality("candidates"."soft_skill_keys") <= 12);--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_tombstone" CHECK ("candidates"."status" <> 'deleted' or ("candidates"."last_name_enc" is null and "candidates"."first_name_enc" is null
				and "candidates"."middle_name_enc" is null and "candidates"."phone_enc" is null and "candidates"."telegram_enc" is null and "candidates"."birth_date" is null
				and "candidates"."headline" is null and cardinality("candidates"."soft_skill_keys") = 0));--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_scope_fields" CHECK (case "consent_events"."kind"
				when 'catalog_visibility' then "consent_events"."scope_fields" is null or "consent_events"."scope_fields" <@ array['fsp_achievements_exact', 'external_profiles']::text[]
				when 'contact_disclosure' then "consent_events"."action" <> 'grant'
					or ("consent_events"."scope_fields" <@ array['full_name', 'email', 'phone', 'telegram', 'resume']::text[] and "consent_events"."scope_fields" @> array['full_name', 'email']::text[])
				when 'public_distribution' then "consent_events"."scope_fields" is null or "consent_events"."scope_fields" <@ array['full_name', 'email', 'phone', 'city', 'categories', 'desired_roles', 'fsp_levels', 'skills', 'fsp_achievements', 'external_profiles']::text[]
				else "consent_events"."scope_fields" is null end);--> statement-breakpoint
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_fields" CHECK (cardinality("disclosures"."fields") > 0 and "disclosures"."fields" <@ array['full_name', 'email', 'phone', 'telegram', 'resume']::text[]);