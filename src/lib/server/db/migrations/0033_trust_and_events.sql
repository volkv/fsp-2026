CREATE TABLE "invitation_complaints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invitation_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"terms_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"text" text NOT NULL,
	"status" text NOT NULL,
	"decision" text,
	"resolution" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_complaints_one_per_offer" UNIQUE("invitation_id","candidate_id"),
	CONSTRAINT "invitation_complaints_reason_code_values" CHECK ("invitation_complaints"."reason_code" in ('terms_mismatch', 'no_real_job', 'contact_harvesting', 'payment_demanded', 'discrimination', 'other')),
	CONSTRAINT "invitation_complaints_status_values" CHECK ("invitation_complaints"."status" in ('open', 'decided')),
	CONSTRAINT "invitation_complaints_decision_values" CHECK ("invitation_complaints"."decision" in ('no_action', 'warning', 'suspension')),
	CONSTRAINT "invitation_complaints_text_length" CHECK (char_length("invitation_complaints"."text") between 10 and 2000),
	CONSTRAINT "invitation_complaints_resolution_length" CHECK (char_length("invitation_complaints"."resolution") between 10 and 2000),
	CONSTRAINT "invitation_complaints_decision_fields" CHECK (case "invitation_complaints"."status"
				when 'open' then "invitation_complaints"."decision" is null and "invitation_complaints"."resolution" is null and "invitation_complaints"."decided_by" is null and "invitation_complaints"."decided_at" is null
				else "invitation_complaints"."decision" is not null and "invitation_complaints"."resolution" is not null and "invitation_complaints"."decided_at" is not null end)
);
--> statement-breakpoint
CREATE TABLE "ats_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscription_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ats_links_subscription_invitation" UNIQUE("subscription_id","invitation_id")
);
--> statement-breakpoint
CREATE TABLE "event_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscription_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"invitation_id" uuid,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_status" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_deliveries_subscription_event" UNIQUE("subscription_id","event_id"),
	CONSTRAINT "event_deliveries_event_type_values" CHECK ("event_deliveries"."event_type" in ('invitation.accepted', 'invitation.declined', 'invitation.expired', 'contacts.disclosed', 'hiring.reported', 'application.received', 'ping')),
	CONSTRAINT "event_deliveries_status_values" CHECK ("event_deliveries"."status" in ('queued', 'delivered', 'failed', 'skipped')),
	CONSTRAINT "event_deliveries_attempts" CHECK ("event_deliveries"."attempts" >= 0),
	CONSTRAINT "event_deliveries_delivered_at" CHECK (("event_deliveries"."status" = 'delivered') = ("event_deliveries"."delivered_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "event_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"target" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"events" text[] NOT NULL,
	"status" text NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"secret_hint" text NOT NULL,
	"previous_secret_enc" "bytea",
	"previous_secret_until" timestamp with time zone,
	"settings" jsonb,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_subscriptions_target_values" CHECK ("event_subscriptions"."target" in ('webhook', 'huntflow')),
	CONSTRAINT "event_subscriptions_status_values" CHECK ("event_subscriptions"."status" in ('active', 'paused')),
	CONSTRAINT "event_subscriptions_name_length" CHECK (char_length("event_subscriptions"."name") between 1 and 100),
	CONSTRAINT "event_subscriptions_target_fields" CHECK (case "event_subscriptions"."target"
				when 'webhook' then "event_subscriptions"."url" is not null and "event_subscriptions"."settings" is null
				else "event_subscriptions"."url" is null and jsonb_typeof("event_subscriptions"."settings") = 'object' end),
	CONSTRAINT "event_subscriptions_events_values" CHECK ("event_subscriptions"."events" <@ array['invitation.accepted', 'invitation.declined', 'invitation.expired', 'contacts.disclosed', 'hiring.reported', 'application.received']::text[]),
	CONSTRAINT "event_subscriptions_events_present" CHECK (cardinality("event_subscriptions"."events") >= 1),
	CONSTRAINT "event_subscriptions_previous_secret" CHECK (("event_subscriptions"."previous_secret_enc" is null) = ("event_subscriptions"."previous_secret_until" is null))
);
--> statement-breakpoint
ALTER TABLE "invitation_complaints" ADD CONSTRAINT "invitation_complaints_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_complaints" ADD CONSTRAINT "invitation_complaints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_complaints" ADD CONSTRAINT "invitation_complaints_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_complaints" ADD CONSTRAINT "invitation_complaints_terms_id_invitation_terms_id_fk" FOREIGN KEY ("terms_id") REFERENCES "public"."invitation_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_complaints" ADD CONSTRAINT "invitation_complaints_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_links" ADD CONSTRAINT "ats_links_subscription_id_event_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."event_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_links" ADD CONSTRAINT "ats_links_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_subscription_id_event_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."event_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_created_by_member_id_company_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitation_complaints_queue" ON "invitation_complaints" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "invitation_complaints_company" ON "invitation_complaints" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "ats_links_invitation" ON "ats_links" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "event_deliveries_subscription" ON "event_deliveries" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "event_deliveries_invitation" ON "event_deliveries" USING btree ("invitation_id") WHERE "event_deliveries"."invitation_id" is not null;--> statement-breakpoint
CREATE INDEX "event_subscriptions_company" ON "event_subscriptions" USING btree ("company_id");