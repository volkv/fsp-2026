-- match_scores keeps only significant pairs with the decomposition as codes and numbers (domain 13.4). Stored rows are
-- recomputed by match.refresh, not here: the table is emptied except the rows invitations refer to («why invited»),
-- which are converted. The foreign key of invitations is dropped for the TRUNCATE and restored after it.
ALTER TABLE "product_policies" DROP CONSTRAINT "product_policies_kind_values";--> statement-breakpoint
ALTER TABLE "product_policies" ADD CONSTRAINT "product_policies_kind_values" CHECK ("product_policies"."kind" in ('invitation_policy', 'hiring_policy', 'notification_policy', 'minor_policy', 'catalog_policy', 'market_policy', 'sourcing_policy', 'assessment_policy', 'retention_policy', 'matching_policy'));--> statement-breakpoint
CREATE TEMPORARY TABLE "match_scores_referenced" ON COMMIT DROP AS
	SELECT * FROM "match_scores" WHERE "id" IN (SELECT "match_score_id" FROM "invitations" WHERE "match_score_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_match_score_id_match_scores_id_fk";--> statement-breakpoint
TRUNCATE "match_scores";--> statement-breakpoint
ALTER TABLE "match_scores" ADD COLUMN "reranker_model_id" text;--> statement-breakpoint
ALTER TABLE "match_scores" ADD COLUMN "component_statuses" text NOT NULL;--> statement-breakpoint
ALTER TABLE "match_scores" ADD COLUMN "required_value" double precision;--> statement-breakpoint
ALTER TABLE "match_scores" ADD COLUMN "nice_value" double precision;--> statement-breakpoint
ALTER TABLE "match_scores" ADD COLUMN "trust_value" double precision;--> statement-breakpoint
ALTER TABLE "match_scores" ADD COLUMN "grade_value" double precision;--> statement-breakpoint
ALTER TABLE "match_scores" ADD COLUMN "salary_value" double precision;--> statement-breakpoint
ALTER TABLE "match_scores" ADD COLUMN "semantic_value" double precision;--> statement-breakpoint
ALTER TABLE "match_scores" ADD COLUMN "reranker_value" double precision;--> statement-breakpoint
ALTER TABLE "match_scores" DROP COLUMN "components";--> statement-breakpoint
ALTER TABLE "match_scores" DROP COLUMN "explanation";--> statement-breakpoint
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_component_statuses" CHECK ("match_scores"."component_statuses" ~ '^[cuan]{7}$');--> statement-breakpoint
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_component_values" CHECK (((substr("match_scores"."component_statuses", 1, 1) = 'c') = ("match_scores"."required_value" is not null)) and ((substr("match_scores"."component_statuses", 2, 1) = 'c') = ("match_scores"."nice_value" is not null)) and ((substr("match_scores"."component_statuses", 3, 1) = 'c') = ("match_scores"."trust_value" is not null)) and ((substr("match_scores"."component_statuses", 4, 1) = 'c') = ("match_scores"."grade_value" is not null)) and ((substr("match_scores"."component_statuses", 5, 1) = 'c') = ("match_scores"."salary_value" is not null)) and ((substr("match_scores"."component_statuses", 6, 1) = 'c') = ("match_scores"."semantic_value" is not null)) and ((substr("match_scores"."component_statuses", 7, 1) = 'c') = ("match_scores"."reranker_value" is not null)));--> statement-breakpoint
INSERT INTO "match_scores" ("id", "vacancy_id", "vacancy_revision", "candidate_id", "candidate_revision",
	"categorization_run_id", "match_ruleset_id", "embedding_space_id", "reranker_model_id", "score", "component_statuses",
	"required_value", "nice_value", "trust_value", "grade_value", "salary_value", "semantic_value", "reranker_value", "computed_at", "job_id")
SELECT r."id", r."vacancy_id", r."vacancy_revision", r."candidate_id", r."candidate_revision", r."categorization_run_id",
	r."match_ruleset_id", r."embedding_space_id",
	CASE WHEN r."components"->'reranker'->>'status' = 'computed' THEN r."components"->'reranker'->'details'->>'model_id' END,
	r."score",
	(SELECT string_agg(CASE r."components"->k.key->>'status' WHEN 'computed' THEN 'c' WHEN 'unknown' THEN 'u'
			WHEN 'unavailable' THEN 'a' WHEN 'not_comparable' THEN 'n' END, '' ORDER BY k.ord)
		FROM unnest(ARRAY['required', 'nice', 'trust', 'grade', 'salary', 'semantic', 'reranker']) WITH ORDINALITY AS k(key, ord)),
	CASE WHEN r."components"->'required'->>'status' = 'computed' THEN (r."components"->'required'->>'value')::double precision END,
	CASE WHEN r."components"->'nice'->>'status' = 'computed' THEN (r."components"->'nice'->>'value')::double precision END,
	CASE WHEN r."components"->'trust'->>'status' = 'computed' THEN (r."components"->'trust'->>'value')::double precision END,
	CASE WHEN r."components"->'grade'->>'status' = 'computed' THEN (r."components"->'grade'->>'value')::double precision END,
	CASE WHEN r."components"->'salary'->>'status' = 'computed' THEN (r."components"->'salary'->>'value')::double precision END,
	CASE WHEN r."components"->'semantic'->>'status' = 'computed' THEN (r."components"->'semantic'->>'value')::double precision END,
	CASE WHEN r."components"->'reranker'->>'status' = 'computed' THEN (r."components"->'reranker'->>'value')::double precision END,
	r."computed_at", r."job_id"
FROM "match_scores_referenced" r;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_match_score_id_match_scores_id_fk" FOREIGN KEY ("match_score_id") REFERENCES "public"."match_scores"("id") ON DELETE set null ON UPDATE no action;
