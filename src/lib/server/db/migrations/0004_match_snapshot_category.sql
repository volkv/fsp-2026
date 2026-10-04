-- A stored match is keyed by the published category it read as well (docs/domain.md, section 13.4): a category
-- recomputed, replaced by an operator or blocked at the same profile revision is another snapshot, not a conflict with
-- the old one. A match read without a category (`categorization_run_id` null) is one value of the key.
ALTER TABLE "match_scores" DROP CONSTRAINT "match_scores_snapshot";--> statement-breakpoint
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_snapshot" UNIQUE NULLS NOT DISTINCT("vacancy_id","vacancy_revision","candidate_id","candidate_revision","categorization_run_id","match_ruleset_id");