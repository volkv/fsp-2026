CREATE TABLE "candidate_surveys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"catalog_version" text NOT NULL,
	"taxonomy_version_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"specialization" text NOT NULL,
	"declared_skill_keys" text[] NOT NULL,
	"preferences" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_surveys_version_positive" CHECK ("candidate_surveys"."version" >= 1),
	CONSTRAINT "candidate_surveys_direction_values" CHECK ("candidate_surveys"."direction" in ('development', 'data', 'quality', 'infrastructure')),
	CONSTRAINT "candidate_surveys_specialization_values" CHECK ("candidate_surveys"."specialization" in ('backend', 'frontend', 'mobile', 'data_ml', 'qa', 'devops')),
	CONSTRAINT "candidate_surveys_declared_skills" CHECK (cardinality("candidate_surveys"."declared_skill_keys") between 1 and 10 and array_position("candidate_surveys"."declared_skill_keys", null) is null),
	CONSTRAINT "candidate_surveys_preferences" CHECK (jsonb_typeof("candidate_surveys"."preferences") = 'object')
);
--> statement-breakpoint
CREATE TABLE "grade_declarations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"survey_id" uuid NOT NULL,
	"specialization" text NOT NULL,
	"grade" text NOT NULL,
	"hint" jsonb NOT NULL,
	"declared_at" timestamp with time zone NOT NULL,
	CONSTRAINT "grade_declarations_specialization_values" CHECK ("grade_declarations"."specialization" in ('backend', 'frontend', 'mobile', 'data_ml', 'qa', 'devops')),
	CONSTRAINT "grade_declarations_grade_values" CHECK ("grade_declarations"."grade" in ('intern', 'junior', 'middle', 'senior')),
	CONSTRAINT "grade_declarations_hint" CHECK (jsonb_typeof("grade_declarations"."hint") = 'object')
);
--> statement-breakpoint
ALTER TABLE "candidate_surveys" ADD CONSTRAINT "candidate_surveys_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_surveys" ADD CONSTRAINT "candidate_surveys_taxonomy_version_id_taxonomy_versions_id_fk" FOREIGN KEY ("taxonomy_version_id") REFERENCES "public"."taxonomy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_declarations" ADD CONSTRAINT "grade_declarations_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_declarations" ADD CONSTRAINT "grade_declarations_survey_id_candidate_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."candidate_surveys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_surveys_version" ON "candidate_surveys" USING btree ("candidate_id","version");--> statement-breakpoint
CREATE INDEX "grade_declarations_candidate" ON "grade_declarations" USING btree ("candidate_id","specialization","declared_at");--> statement-breakpoint

-- Written by hand (drizzle-kit does not express triggers): surveys and declarations are append-only (domain 12.2);
-- only the retention role deletes them, at the purge of the account (rule of migration 0002).
CREATE TRIGGER candidate_surveys_append_only BEFORE UPDATE OR DELETE ON candidate_surveys
	FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation('purgeable');
--> statement-breakpoint
CREATE TRIGGER candidate_surveys_append_only_truncate BEFORE TRUNCATE ON candidate_surveys
	FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation('purgeable');
--> statement-breakpoint
GRANT SELECT, DELETE ON candidate_surveys TO fsp_retention;
--> statement-breakpoint
CREATE TRIGGER grade_declarations_append_only BEFORE UPDATE OR DELETE ON grade_declarations
	FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation('purgeable');
--> statement-breakpoint
CREATE TRIGGER grade_declarations_append_only_truncate BEFORE TRUNCATE ON grade_declarations
	FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation('purgeable');
--> statement-breakpoint
GRANT SELECT, DELETE ON grade_declarations TO fsp_retention;
