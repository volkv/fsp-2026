DROP INDEX "vacancy_claims_one_approved";--> statement-breakpoint
ALTER TABLE "vacancy_claims" ADD COLUMN "demo_session_id" uuid;--> statement-breakpoint
ALTER TABLE "vacancy_claims" ADD CONSTRAINT "vacancy_claims_demo_session_id_demo_sessions_id_fk" FOREIGN KEY ("demo_session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A claim takes the place of its company: an approval holds within it.
UPDATE "vacancy_claims" vc SET "demo_session_id" = c."demo_session_id" FROM "companies" c WHERE c."id" = vc."company_id" AND c."demo_session_id" IS NOT NULL;--> statement-breakpoint
-- A company of a demo session no longer records its approval or its own vacancy on the shared external vacancy: what
-- sessions have recorded there is taken back (their claims and own vacancies keep it within the session).
UPDATE "vacancies" v SET "claimed_company_id" = NULL FROM "companies" c WHERE c."id" = v."claimed_company_id" AND c."demo_session_id" IS NOT NULL;--> statement-breakpoint
UPDATE "vacancies" v SET "superseded_by_vacancy_id" = NULL FROM "vacancies" d JOIN "companies" c ON c."id" = d."company_id" WHERE d."id" = v."superseded_by_vacancy_id" AND c."demo_session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vacancy_claims_one_approved_demo" ON "vacancy_claims" USING btree ("vacancy_id","demo_session_id") WHERE "vacancy_claims"."status" = 'approved' and "vacancy_claims"."demo_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "vacancy_claims_one_approved" ON "vacancy_claims" USING btree ("vacancy_id") WHERE "vacancy_claims"."status" = 'approved' and "vacancy_claims"."demo_session_id" is null;
