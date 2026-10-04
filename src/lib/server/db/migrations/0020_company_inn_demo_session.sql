DROP INDEX "companies_inn_not_rejected";--> statement-breakpoint
-- The clone of a company of the cast was given a number of its own while numbers were unique across the stand; it
-- takes the number of its original back.
UPDATE "companies" c SET "inn" = o."inn" FROM "companies" o WHERE c."demo_clone_of" = o."id" AND c."inn" <> o."inn";--> statement-breakpoint
CREATE UNIQUE INDEX "companies_inn_not_rejected_demo" ON "companies" USING btree ("inn","demo_session_id") WHERE "companies"."status" <> 'rejected' and "companies"."demo_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_inn_not_rejected" ON "companies" USING btree ("inn") WHERE "companies"."status" <> 'rejected' and "companies"."demo_session_id" is null;
