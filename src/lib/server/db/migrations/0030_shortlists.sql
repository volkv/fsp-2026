CREATE TABLE "salary_cohort_snapshots" (
	"company_id" uuid NOT NULL,
	"specialization" text NOT NULL,
	"grade" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"policy_version" integer NOT NULL,
	"cohort" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salary_cohort_snapshots_pk" PRIMARY KEY("company_id","specialization","grade","snapshot_date"),
	CONSTRAINT "salary_cohort_snapshots_cohort" CHECK (jsonb_typeof("salary_cohort_snapshots"."cohort") = 'object')
);
--> statement-breakpoint
CREATE TABLE "shortlist_evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shortlist_id" uuid NOT NULL,
	"revision_seq" integer NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"cards" jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"judged_at" timestamp with time zone,
	CONSTRAINT "shortlist_evaluations_judged" CHECK (("shortlist_evaluations"."judged_at" is null) = ("shortlist_evaluations"."result" is null))
);
--> statement-breakpoint
CREATE TABLE "shortlist_marks" (
	"shortlist_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"marked_by_member_id" uuid NOT NULL,
	"marked_at" timestamp with time zone NOT NULL,
	"unmarked_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "shortlist_marks_pk" PRIMARY KEY("shortlist_id","candidate_id"),
	CONSTRAINT "shortlist_marks_note_length" CHECK (char_length("shortlist_marks"."note") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "shortlist_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shortlist_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"query" jsonb NOT NULL,
	"change" jsonb NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shortlist_revisions_seq" UNIQUE("shortlist_id","seq"),
	CONSTRAINT "shortlist_revisions_seq_positive" CHECK ("shortlist_revisions"."seq" >= 1),
	CONSTRAINT "shortlist_revisions_query" CHECK (jsonb_typeof("shortlist_revisions"."query") = 'object'),
	CONSTRAINT "shortlist_revisions_change" CHECK (jsonb_typeof("shortlist_revisions"."change") = 'object')
);
--> statement-breakpoint
CREATE TABLE "shortlists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"need_id" uuid NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shortlists_status_values" CHECK ("shortlists"."status" in ('open', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "salary_cohort_snapshots" ADD CONSTRAINT "salary_cohort_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_evaluations" ADD CONSTRAINT "shortlist_evaluations_shortlist_id_shortlists_id_fk" FOREIGN KEY ("shortlist_id") REFERENCES "public"."shortlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_evaluations" ADD CONSTRAINT "shortlist_evaluations_created_by_member_id_company_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_marks" ADD CONSTRAINT "shortlist_marks_shortlist_id_shortlists_id_fk" FOREIGN KEY ("shortlist_id") REFERENCES "public"."shortlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_marks" ADD CONSTRAINT "shortlist_marks_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_marks" ADD CONSTRAINT "shortlist_marks_marked_by_member_id_company_members_id_fk" FOREIGN KEY ("marked_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_revisions" ADD CONSTRAINT "shortlist_revisions_shortlist_id_shortlists_id_fk" FOREIGN KEY ("shortlist_id") REFERENCES "public"."shortlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_revisions" ADD CONSTRAINT "shortlist_revisions_created_by_member_id_company_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlists" ADD CONSTRAINT "shortlists_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlists" ADD CONSTRAINT "shortlists_need_id_hiring_needs_id_fk" FOREIGN KEY ("need_id") REFERENCES "public"."hiring_needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlists" ADD CONSTRAINT "shortlists_created_by_member_id_company_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shortlist_evaluations_shortlist" ON "shortlist_evaluations" USING btree ("shortlist_id");--> statement-breakpoint
CREATE INDEX "shortlist_marks_candidate" ON "shortlist_marks" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "shortlists_need" ON "shortlists" USING btree ("company_id","need_id");--> statement-breakpoint

-- Written by hand (drizzle-kit does not express triggers): the steps of a shortlist are append-only (domain 13.10);
-- only the retention role deletes them, when a demo session goes away (rule of migration 0002).
CREATE TRIGGER shortlist_revisions_append_only BEFORE UPDATE OR DELETE ON shortlist_revisions
	FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation('purgeable');
--> statement-breakpoint
CREATE TRIGGER shortlist_revisions_append_only_truncate BEFORE TRUNCATE ON shortlist_revisions
	FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation('purgeable');
--> statement-breakpoint
GRANT SELECT, DELETE ON shortlist_revisions TO fsp_retention;
