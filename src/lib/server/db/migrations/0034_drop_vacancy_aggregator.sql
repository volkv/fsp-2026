-- The platform keeps only the vacancies companies publish on it: vacancies imported from other sites, their sources,
-- postings, import runs and «this is our vacancy» claims leave the product, with the queue of unknown skills that only
-- the postings filled and the policy of their freshness.
DROP TABLE "unknown_skill_mentions";--> statement-breakpoint
DROP TABLE "vacancy_claims";--> statement-breakpoint
DROP TABLE "vacancy_postings";--> statement-breakpoint
DROP TABLE "vacancy_import_runs";--> statement-breakpoint
DROP TABLE "vacancy_sources";--> statement-breakpoint
UPDATE "api_keys" SET "permissions" = array_remove("permissions", 'vacancy.external.read')
	WHERE 'vacancy.external.read' = ANY("permissions");--> statement-breakpoint
DELETE FROM "jobs" WHERE "type" IN ('vacancies.import', 'vacancies.freshness_check', 'vacancy.normalize');--> statement-breakpoint
ALTER TABLE "vacancies" DROP CONSTRAINT "vacancies_claimed_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "vacancies" DROP CONSTRAINT "vacancies_derived_from_vacancy_id_vacancies_id_fk";--> statement-breakpoint
ALTER TABLE "vacancies" DROP CONSTRAINT "vacancies_superseded_by_vacancy_id_vacancies_id_fk";--> statement-breakpoint
-- What was derived from external vacancies goes with them. An application or an offer naming one cannot exist
-- (both take only an own vacancy); if one does, the foreign key stops the migration instead of losing it.
DELETE FROM "match_scores" WHERE "vacancy_id" IN (SELECT "id" FROM "vacancies" WHERE "origin" = 'external');--> statement-breakpoint
DELETE FROM "embeddings" WHERE "owner_type" = 'vacancy'
	AND "owner_id" IN (SELECT "id"::text FROM "vacancies" WHERE "origin" = 'external');--> statement-breakpoint
DELETE FROM "jobs" WHERE "status" = 'queued' AND "type" IN ('vacancy.embed', 'match.refresh')
	AND "payload" ->> 'vacancy_id' IN (SELECT "id"::text FROM "vacancies" WHERE "origin" = 'external');--> statement-breakpoint
DELETE FROM "vacancies" WHERE "origin" = 'external';--> statement-breakpoint
-- The vacancy ranges of the market were computed with external vacancies; `market.refresh` recomputes them.
DELETE FROM "market_snapshots" WHERE "indicator" = 'vacancy_ranges';--> statement-breakpoint
ALTER TABLE "vacancies" DROP CONSTRAINT "vacancies_origin_values";--> statement-breakpoint
ALTER TABLE "vacancies" DROP CONSTRAINT "vacancies_grade_basis_values";--> statement-breakpoint
ALTER TABLE "vacancies" DROP CONSTRAINT "vacancies_status_by_origin";--> statement-breakpoint
ALTER TABLE "vacancies" DROP CONSTRAINT "vacancies_own_fields";--> statement-breakpoint
ALTER TABLE "vacancies" DROP CONSTRAINT "vacancies_external_fields";--> statement-breakpoint
ALTER TABLE "vacancies" DROP CONSTRAINT "vacancies_grade_pair";--> statement-breakpoint
ALTER TABLE "vacancies" DROP CONSTRAINT "vacancies_grade_basis";--> statement-breakpoint
DROP INDEX "vacancies_origin_status";--> statement-breakpoint
ALTER TABLE "vacancies" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vacancies" ALTER COLUMN "created_by_member_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vacancies" ALTER COLUMN "description" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vacancies" ALTER COLUMN "role_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vacancies" ALTER COLUMN "grade_min" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vacancies" ALTER COLUMN "grade_max" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vacancies" ALTER COLUMN "work_format" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vacancies" ALTER COLUMN "employment_form" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vacancies" ALTER COLUMN "contract_types" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "vacancies_status" ON "vacancies" USING btree ("status");--> statement-breakpoint
ALTER TABLE "vacancies" DROP COLUMN "origin";--> statement-breakpoint
ALTER TABLE "vacancies" DROP COLUMN "external_org";--> statement-breakpoint
ALTER TABLE "vacancies" DROP COLUMN "claimed_company_id";--> statement-breakpoint
ALTER TABLE "vacancies" DROP COLUMN "derived_from_vacancy_id";--> statement-breakpoint
ALTER TABLE "vacancies" DROP COLUMN "superseded_by_vacancy_id";--> statement-breakpoint
ALTER TABLE "vacancies" DROP COLUMN "grade_basis";--> statement-breakpoint
ALTER TABLE "vacancies" DROP COLUMN "terms_conflict";--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_status_values" CHECK ("vacancies"."status" in ('draft', 'pending_moderation', 'published', 'paused', 'closed'));--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_full_salary" CHECK ("vacancies"."salary_min" is not null and "vacancies"."salary_max" is not null and "vacancies"."salary_tax_base" in ('gross', 'net'));--> statement-breakpoint
-- `sourcing_policy` governed only the freshness of external vacancies. Product policies are immutable reference data
-- (migration 0002); its versions are removed here once, with the trigger off for this statement only.
ALTER TABLE "product_policies" DROP CONSTRAINT "product_policies_kind_values";--> statement-breakpoint
ALTER TABLE "product_policies" DISABLE TRIGGER "product_policies_append_only";--> statement-breakpoint
DELETE FROM "product_policies" WHERE "kind" = 'sourcing_policy';--> statement-breakpoint
ALTER TABLE "product_policies" ENABLE TRIGGER "product_policies_append_only";--> statement-breakpoint
ALTER TABLE "product_policies" ADD CONSTRAINT "product_policies_kind_values" CHECK ("product_policies"."kind" in ('invitation_policy', 'hiring_policy', 'notification_policy', 'minor_policy', 'catalog_policy', 'market_policy', 'assessment_policy', 'retention_policy', 'matching_policy', 'challenge_policy'));
