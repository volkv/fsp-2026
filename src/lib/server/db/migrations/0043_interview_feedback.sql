CREATE TABLE "interview_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"process_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"terms_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"specialization" text NOT NULL,
	"grade" text NOT NULL,
	"bank_release_id" text NOT NULL,
	"level" text NOT NULL,
	"block_levels" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"comment" text,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_feedback_process" UNIQUE("process_id"),
	CONSTRAINT "interview_feedback_specialization_values" CHECK ("interview_feedback"."specialization" in ('backend', 'frontend', 'mobile', 'data_ml', 'qa', 'devops')),
	CONSTRAINT "interview_feedback_grade_values" CHECK ("interview_feedback"."grade" in ('intern', 'junior', 'middle', 'senior')),
	CONSTRAINT "interview_feedback_level_values" CHECK ("interview_feedback"."level" in ('below', 'matches', 'above')),
	CONSTRAINT "interview_feedback_outcome_values" CHECK ("interview_feedback"."outcome" in ('advanced', 'offer', 'rejected', 'candidate_declined')),
	CONSTRAINT "interview_feedback_block_levels" CHECK (jsonb_typeof("interview_feedback"."block_levels") = 'object'),
	CONSTRAINT "interview_feedback_comment_length" CHECK (char_length("interview_feedback"."comment") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "interview_feedback" ADD CONSTRAINT "interview_feedback_process_id_hiring_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."hiring_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback" ADD CONSTRAINT "interview_feedback_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback" ADD CONSTRAINT "interview_feedback_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback" ADD CONSTRAINT "interview_feedback_terms_id_invitation_terms_id_fk" FOREIGN KEY ("terms_id") REFERENCES "public"."invitation_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback" ADD CONSTRAINT "interview_feedback_category_id_candidate_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."candidate_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback" ADD CONSTRAINT "interview_feedback_bank_release_id_bank_releases_id_fk" FOREIGN KEY ("bank_release_id") REFERENCES "public"."bank_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_feedback" ADD CONSTRAINT "interview_feedback_created_by_member_id_company_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interview_feedback_candidate" ON "interview_feedback" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "interview_feedback_calibration" ON "interview_feedback" USING btree ("specialization","grade","bank_release_id");