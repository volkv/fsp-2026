CREATE TABLE "invitation_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invitation_id" uuid NOT NULL,
	"author_side" text NOT NULL,
	"author_member_id" uuid,
	"text" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_messages_author_side_values" CHECK ("invitation_messages"."author_side" in ('candidate', 'company')),
	CONSTRAINT "invitation_messages_author" CHECK (("invitation_messages"."author_side" = 'company') = ("invitation_messages"."author_member_id" is not null)),
	CONSTRAINT "invitation_messages_text_length" CHECK (char_length("invitation_messages"."text") between 1 and 2000),
	CONSTRAINT "invitation_messages_read_after_sent" CHECK ("invitation_messages"."read_at" is null or "invitation_messages"."read_at" >= "invitation_messages"."created_at")
);
--> statement-breakpoint
ALTER TABLE "invitation_messages" ADD CONSTRAINT "invitation_messages_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_messages" ADD CONSTRAINT "invitation_messages_author_member_id_company_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."company_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitation_messages_invitation" ON "invitation_messages" USING btree ("invitation_id","created_at");