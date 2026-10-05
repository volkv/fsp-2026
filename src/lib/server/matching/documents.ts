// Text documents of full-text search (PostgreSQL `russian` configuration: Russian morphology, English stems for Latin
// words) and of the reranker. A candidate document holds only what the catalog projection shows (domain 14): skills
// of the valid evidence run, the categories in force with their confirmed stack, FSP disciplines, roles and applied
// skills of experience groups, desired roles — never titles as written, organizations, the headline or resume text. It
// is built at query time from evidence active at that moment, so a withdrawal removes its words from search
// immediately (domain 17.3). Names come from one taxonomy version per document: the one of the evidence run, or the
// version in force without a run — never several versions at once while a new release is being recalculated.
import { sql, type SQL } from 'drizzle-orm';
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { activeCategoryRows } from '$lib/server/categories/read';
import type { Executor } from '$lib/server/db';
import { candidateAt, runAt, runInForce } from '$lib/server/db/conditions';
import { textList } from './sql';

export interface SearchDocument {
	body: string;
	/** Relevance of the query in [0, 1); `null` without a query. */
	rank: number | null;
	/** The document matches the query; `true` without a query. */
	matched: boolean;
}

const RANK_NORMALIZATION = 32; // ts_rank_cd flag: rank / (rank + 1), a value in [0, 1).

/** Titles of the specializations and grades of the catalog as a `values` list: they are words of the document. */
const catalogTitles = sql`(values ${sql.join(
	[...CATALOG.specializations, ...CATALOG.grades].map((entry) => sql`(${entry.key}, ${entry.title})`),
	sql`, `
)})`;

/**
 * The documents of `d` with the relevance of `text`. `d` must be materialized: an inlined one would build the text of a
 * document, subqueries included, once for every reference to it. The vector of a document is computed once.
 */
function ranked(text: string | null): SQL {
	if (text === null) return sql`select d.id, d.body, null::float8 as rank, true as matched from d`;
	const query = sql`websearch_to_tsquery('russian', ${text})`;
	return sql`select d.id, d.body, ts_rank_cd(v.vector, ${query}, ${RANK_NORMALIZATION})::float8 as rank,
		(v.vector @@ ${query}) as matched
		from d, lateral (select to_tsvector('russian', d.body) as vector) v`;
}

type DocumentRow = { id: string; body: string; rank: number | null; matched: boolean };

function toMap(rows: readonly DocumentRow[]): Map<string, SearchDocument> {
	return new Map(rows.map((row) => [row.id, { body: row.body, rank: row.rank, matched: row.matched }]));
}

/**
 * Catalog documents of the candidates with the relevance of `text`, if given. The aliases of the skills are gathered
 * once, as a map per taxonomy version: `skill_aliases` is keyed by the alias, so a lookup per inference reads every
 * alias of the version. Words keep the order they had, and with it the rank of a query of several words.
 */
export async function candidateDocuments(
	executor: Executor,
	candidateIds: readonly string[],
	text: string | null
): Promise<Map<string, SearchDocument>> {
	if (candidateIds.length === 0) return new Map();
	const rows = await executor.execute<DocumentRow>(sql`
		with active as (
			select t.id from taxonomy_versions t
			where t.status = 'published' and t.published_at is not null
			order by t.published_at desc, t.id desc
			limit 1
		),
		base as (
			select c.id, c.desired_role_keys, r.id as run_id, coalesce(r.taxonomy_version_id, (select id from active)) as tv
			from candidates c
			left join evidence_runs r on r.candidate_id = c.id and ${runInForce(runAt('r'), candidateAt('c'))}
			where c.id::text in ${textList(candidateIds)}
		),
		aliases as materialized (
			select tv, jsonb_object_agg(skill_key, names) as of_skill
			from (
				select al.taxonomy_version_id as tv, al.skill_key, string_agg(al.alias_normalized, ' ') as names
				from skill_aliases al
				where al.taxonomy_version_id in (select b.tv from base b)
				group by al.taxonomy_version_id, al.skill_key
			) per_skill
			group by tv
		),
		d as materialized (
			select b.id::text as id, concat_ws(' ',
				(select string_agg(concat_ws(' ', i.skill_key, s.name, sa.of_skill ->> i.skill_key), ' ')
					from skill_inferences i
					left join skills s on s.taxonomy_version_id = b.tv and s.key = i.skill_key
					where i.run_id = b.run_id),
				(select string_agg(concat_ws(' ', k.specialization, st.text, k.grade, gt.text,
						array_to_string(k.confirmed_skill_keys, ' ')), ' ')
					from ${activeCategoryRows} k
					left join ${catalogTitles} st(key, text) on st.key = k.specialization
					left join ${catalogTitles} gt(key, text) on gt.key = k.grade
					where k.candidate_id = b.id),
				(select string_agg(fl.discipline, ' ') from fsp_level_assignments fl where fl.run_id = b.run_id),
				(select string_agg(concat_ws(' ', e.role_key,
						(select ro.name_ru from roles ro where ro.taxonomy_version_id = b.tv and ro.key = e.role_key),
						array_to_string(e.applied_skill_keys, ' ')), ' ')
					from experience_entries e
					join source_facts f on f.id = e.fact_id
					where e.candidate_id = b.id and e.status = 'active' and f.status = 'active'
						and e.candidate_review <> 'rejected'),
				(select string_agg(concat_ws(' ', k.key, ro.name_ru), ' ' order by k.ordinal)
					from unnest(b.desired_role_keys) with ordinality as k(key, ordinal)
					left join roles ro on ro.taxonomy_version_id = b.tv and ro.key = k.key)
			) as body
			from base b
			left join aliases sa on sa.tv = b.tv
		)
		${ranked(text)}
	`);
	return toMap(rows);
}

/** Documents of vacancies: title, description when stored, role and skills with their names. */
export async function vacancyDocuments(
	executor: Executor,
	vacancyIds: readonly string[],
	text: string | null
): Promise<Map<string, SearchDocument>> {
	if (vacancyIds.length === 0) return new Map();
	const rows = await executor.execute<DocumentRow>(sql`
		with d as materialized (
			select v.id::text as id, concat_ws(' ',
				v.title,
				v.description,
				v.role_key,
				(select ro.name_ru from roles ro where ro.taxonomy_version_id = v.taxonomy_version_id and ro.key = v.role_key),
				(select string_agg(concat_ws(' ', k.key, s.name), ' ')
					from unnest(v.required_skill_keys || v.nice_skill_keys) as k(key)
					left join skills s on s.taxonomy_version_id = v.taxonomy_version_id and s.key = k.key)
			) as body
			from vacancies v
			where v.id::text in ${textList(vacancyIds)}
		)
		${ranked(text)}
	`);
	return toMap(rows);
}
