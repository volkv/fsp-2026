ALTER TABLE "unknown_skill_mentions" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unknown_skill_mentions" ADD COLUMN "last_posting_id" uuid;--> statement-breakpoint
ALTER TABLE "unknown_skill_mentions" ADD CONSTRAINT "unknown_skill_mentions_last_posting_id_vacancy_postings_id_fk" FOREIGN KEY ("last_posting_id") REFERENCES "public"."vacancy_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Where each spelling was last seen: the latest fetched posting whose normalization still leaves it unknown, matched
-- in the canonical form of skill normalization (`normalizeSkillText`). A spelling no posting carries keeps `null`.
WITH "seen" AS (
	SELECT DISTINCT ON ("key") "key", p."id", p."last_fetched_at"
	FROM "vacancy_postings" p
	CROSS JOIN LATERAL jsonb_array_elements_text(p."normalized" -> 'skills' -> 'unknown') AS w("written")
	CROSS JOIN LATERAL (
		SELECT regexp_replace(regexp_replace(btrim(regexp_replace(regexp_replace(regexp_replace(replace(
			lower(normalize(w."written", NFKC)), 'ё', 'е'),
			'[‐-―−]', '-', 'g'),
			'[_-]', ' ', 'g'),
			'\s+', ' ', 'g'), ' '),
			'^[\s"''«»“”„()\[\]{},;:!?]+', ''),
			'[\s"''«»“”„()\[\]{},;:!?.]+$', '') AS "key"
	) k
	WHERE p."normalization_version" <> 'pending' AND jsonb_typeof(p."normalized" -> 'skills' -> 'unknown') = 'array'
	ORDER BY "key", p."last_fetched_at" DESC, p."id" DESC
)
UPDATE "unknown_skill_mentions" m SET "last_seen_at" = "seen"."last_fetched_at", "last_posting_id" = "seen"."id"
FROM "seen" WHERE "seen"."key" = m."raw_normalized" AND m."last_seen_at" IS NULL;--> statement-breakpoint
-- Vacancies that were already waiting in moderation before its cases were kept got `moderation: null` from 0018, and
-- the operator's queue cannot read them: each gets the case it would have been opened with — since its last change,
-- back to the catalog when approved, no decision yet. A case already there is left as it is.
UPDATE "vacancies" SET "text_check" = jsonb_set("text_check", '{moderation}', jsonb_build_object(
	'opened_at', to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
	'resume_to', 'published',
	'decision', NULL))
WHERE "status" = 'pending_moderation' AND coalesce("text_check" -> 'moderation', 'null'::jsonb) = 'null'::jsonb;
