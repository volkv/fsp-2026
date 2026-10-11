CREATE TABLE "bank_family_quarantines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"specialization" text NOT NULL,
	"family_key" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"quarantined_by" uuid NOT NULL,
	"quarantined_at" timestamp with time zone NOT NULL,
	"lifted_by" uuid,
	"lifted_at" timestamp with time zone,
	CONSTRAINT "bank_family_quarantines_reason_values" CHECK ("bank_family_quarantines"."reason" in ('solve_rate_signal', 'foreign_answers', 'published', 'other')),
	CONSTRAINT "bank_family_quarantines_lifted" CHECK (("bank_family_quarantines"."lifted_at" is null) = ("bank_family_quarantines"."lifted_by" is null)),
	CONSTRAINT "bank_family_quarantines_note" CHECK ("bank_family_quarantines"."note" is null or char_length("bank_family_quarantines"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "bank_family_quarantines" ADD CONSTRAINT "bank_family_quarantines_quarantined_by_users_id_fk" FOREIGN KEY ("quarantined_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_family_quarantines" ADD CONSTRAINT "bank_family_quarantines_lifted_by_users_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_family_quarantines_one_active" ON "bank_family_quarantines" USING btree ("specialization","family_key") WHERE "bank_family_quarantines"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "test_items_family_served" ON "test_items" USING btree ("family_key","served_at");