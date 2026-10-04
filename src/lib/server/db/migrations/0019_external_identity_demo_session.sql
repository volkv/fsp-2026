ALTER TABLE "external_identities" DROP CONSTRAINT "external_identities_issuer_subject";--> statement-breakpoint
ALTER TABLE "external_identities" ADD COLUMN "demo_session_id" uuid;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_demo_session_id_demo_sessions_id_fk" FOREIGN KEY ("demo_session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Identities of accounts in demo sessions carry the session; a clone's identity keeps the subject of the original.
UPDATE "external_identities" i SET "demo_session_id" = u."demo_session_id",
	"subject" = regexp_replace(i."subject", '^demo:' || u."demo_session_id"::text || ':', '')
	FROM "users" u WHERE u."id" = i."user_id" AND u."demo_session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_issuer_subject" ON "external_identities" USING btree ("issuer","subject") WHERE "external_identities"."demo_session_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_issuer_subject_demo" ON "external_identities" USING btree ("issuer","subject","demo_session_id") WHERE "external_identities"."demo_session_id" is not null;