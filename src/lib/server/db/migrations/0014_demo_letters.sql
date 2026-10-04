CREATE TABLE "demo_letters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"demo_session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid NOT NULL,
	"recipient_masked" text NOT NULL,
	"subject" text NOT NULL,
	"body_enc" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_letters_kind_values" CHECK ("demo_letters"."kind" in ('consents', 'disclosure'))
);
--> statement-breakpoint
ALTER TABLE "demo_letters" ADD CONSTRAINT "demo_letters_demo_session_id_demo_sessions_id_fk" FOREIGN KEY ("demo_session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demo_letters_session" ON "demo_letters" USING btree ("demo_session_id","created_at");