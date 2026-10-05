// The query of a shortlist step and its refinements (docs/domain.md, section 13.10): the need's form as it stands at
// the step, the categories the shortlist takes candidates from, and the filters. A query never names a candidate —
// candidates are found anew at every opening. A refinement changes some of these fields; the step records what changed
// against the previous one. «What if» changes exactly one condition.
import { z } from 'zod';
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import type { NeedSearch, CandidateSearchFilters } from '$lib/server/matching/search';
import { needFormSchema, needSalarySchema, type NeedForm } from '$lib/server/needs/form';
import { OFFER_WORK_FORMATS } from '$lib/server/invitations/terms';

const skillKey = z.string().regex(/^[a-z0-9_]+$/u);

export const MAX_CATEGORIES = 12;

export const categoryPairSchema = z.strictObject({
	specialization: z.enum(SPECIALIZATION_KEYS),
	grade: z.enum(GRADE_KEYS)
});

export type CategoryPair = z.infer<typeof categoryPairSchema>;

const categoriesSchema = z
	.array(categoryPairSchema)
	.min(1)
	.max(MAX_CATEGORIES)
	.refine(
		(pairs) => new Set(pairs.map((p) => `${p.specialization}:${p.grade}`)).size === pairs.length,
		'Категории повторяются'
	);

export const shortlistFiltersSchema = z.strictObject({
	/** Only candidates with an FSP result in force. */
	fsp_only: z.boolean(),
	/** Only candidates who accept one of these work formats; empty — any. */
	work_formats: z.array(z.enum(OFFER_WORK_FORMATS)).max(3),
	/** Only candidates whose test confirmed all of these skills; empty — none required. */
	confirmed_skill_keys: z.array(skillKey).max(10)
});

export const shortlistQuerySchema = z.strictObject({
	form: needFormSchema,
	categories: categoriesSchema,
	filters: shortlistFiltersSchema
});

export type ShortlistQuery = z.infer<typeof shortlistQuerySchema>;
export type ShortlistFilters = z.infer<typeof shortlistFiltersSchema>;

/** A refinement: the fields that change; a field left out stays as it was, `null` clears an optional one. */
export const shortlistChangeSchema = z
	.strictObject({
		categories: categoriesSchema.optional(),
		skill_keys: z.array(skillKey).max(30).optional(),
		nice_skill_keys: z.array(skillKey).max(30).optional(),
		work_format: z.enum(OFFER_WORK_FORMATS).nullable().optional(),
		region_code: z.string().min(1).nullable().optional(),
		salary: needSalarySchema.nullable().optional(),
		fsp_relevant: z.boolean().optional(),
		fsp_only: z.boolean().optional(),
		work_formats: z.array(z.enum(OFFER_WORK_FORMATS)).max(3).optional(),
		confirmed_skill_keys: z.array(skillKey).max(10).optional()
	})
	.refine((change) => Object.keys(change).length > 0, 'Уточнение ничего не меняет');

export type ShortlistChange = z.infer<typeof shortlistChangeSchema>;

/** The query of the next step. */
export function applyChange(query: ShortlistQuery, change: ShortlistChange): ShortlistQuery {
	const { work_format: format, region_code: region, salary, ...rest } = query.form;
	const form: NeedForm = {
		...rest,
		...(change.work_format === undefined
			? format === undefined
				? {}
				: { work_format: format }
			: change.work_format === null
				? {}
				: { work_format: change.work_format }),
		...(change.region_code === undefined
			? region === undefined
				? {}
				: { region_code: region }
			: change.region_code === null
				? {}
				: { region_code: change.region_code }),
		...(change.salary === undefined
			? salary === undefined
				? {}
				: { salary }
			: change.salary === null
				? {}
				: { salary: change.salary })
	};
	if (change.skill_keys !== undefined) form.skill_keys = [...new Set(change.skill_keys)];
	if (change.nice_skill_keys !== undefined) form.nice_skill_keys = [...new Set(change.nice_skill_keys)];
	if (change.fsp_relevant !== undefined) form.fsp_relevant = change.fsp_relevant;
	return {
		form,
		categories: change.categories ?? query.categories,
		filters: {
			fsp_only: change.fsp_only ?? query.filters.fsp_only,
			work_formats: change.work_formats ? [...new Set(change.work_formats)] : query.filters.work_formats,
			confirmed_skill_keys: change.confirmed_skill_keys
				? [...new Set(change.confirmed_skill_keys)]
				: query.filters.confirmed_skill_keys
		}
	};
}

/** The fields that differ between two queries, each with its value before and after (`null` — not set). */
export type QueryDiff = Partial<Record<keyof ShortlistChange, { from: unknown; to: unknown }>>;

function fieldsOf(query: ShortlistQuery): Record<keyof ShortlistChange, unknown> {
	return {
		categories: query.categories,
		skill_keys: query.form.skill_keys,
		nice_skill_keys: query.form.nice_skill_keys,
		work_format: query.form.work_format ?? null,
		region_code: query.form.region_code ?? null,
		salary: query.form.salary ?? null,
		fsp_relevant: query.form.fsp_relevant ?? true,
		fsp_only: query.filters.fsp_only,
		work_formats: query.filters.work_formats,
		confirmed_skill_keys: query.filters.confirmed_skill_keys
	};
}

export function diffQueries(before: ShortlistQuery, after: ShortlistQuery): QueryDiff {
	const a = fieldsOf(before);
	const b = fieldsOf(after);
	const diff: QueryDiff = {};
	for (const key of Object.keys(b) as (keyof ShortlistChange)[]) {
		if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) diff[key] = { from: a[key], to: b[key] };
	}
	return diff;
}

/** «What if»: exactly one condition changes (contracts 10.2). */
export const whatIfSchema = z.union([
	z.strictObject({ work_format: z.enum(OFFER_WORK_FORMATS).nullable() }),
	z.strictObject({ grade: z.enum(GRADE_KEYS) }),
	z.strictObject({ confirmed_skill: z.strictObject({ skill_key: skillKey, required: z.boolean() }) }),
	z.strictObject({ fsp_only: z.boolean() }),
	z.strictObject({
		salary: z.strictObject({ min: z.int().positive(), max: z.int().positive(), tax_base: z.enum(['gross', 'net']) })
	})
]);

export type WhatIf = z.infer<typeof whatIfSchema>;

/** The query «what if» ranks against the current one; a change of the range alone keeps the candidates as they are. */
export function whatIfQuery(query: ShortlistQuery, change: WhatIf): ShortlistQuery {
	if ('work_format' in change) {
		return {
			...query,
			form: { ...query.form, ...(change.work_format === null ? {} : { work_format: change.work_format }) },
			filters: { ...query.filters, work_formats: change.work_format === null ? [] : [change.work_format] }
		};
	}
	if ('grade' in change) {
		const specializations = [...new Set(query.categories.map((c) => c.specialization))];
		return {
			...query,
			form: { ...query.form, grade: { min: change.grade, max: change.grade } },
			categories: specializations.map((specialization) => ({ specialization, grade: change.grade }))
		};
	}
	if ('confirmed_skill' in change) {
		const { skill_key: key, required } = change.confirmed_skill;
		const others = query.filters.confirmed_skill_keys.filter((k) => k !== key);
		return {
			...query,
			filters: { ...query.filters, confirmed_skill_keys: required ? [...others, key] : others }
		};
	}
	if ('fsp_only' in change) return { ...query, filters: { ...query.filters, fsp_only: change.fsp_only } };
	return query;
}

/** What the search reads of a step: the categories and filters, and the need it ranks for. */
export function searchOf(
	query: ShortlistQuery,
	needText: string | null,
	shortlist: { id: string; revision: number }
): { filters: CandidateSearchFilters; need: NeedSearch } {
	const { form, filters } = query;
	return {
		filters: {
			categories: query.categories.map((c) => ({ specialization: c.specialization, grade: c.grade })),
			...(filters.confirmed_skill_keys.length > 0 ? { confirmedSkillKeys: filters.confirmed_skill_keys } : {}),
			...(filters.work_formats.length > 0 ? { workFormats: filters.work_formats } : {}),
			...(filters.fsp_only ? { fspConfirmed: true } : {})
		},
		need: {
			spec: {
				requiredSkillKeys: form.skill_keys,
				niceSkillKeys: form.nice_skill_keys,
				workFormat: form.work_format ?? null,
				regionCode: form.region_code ?? null,
				fspRelevant: form.fsp_relevant !== false,
				categories: query.categories
			},
			semanticText: needText,
			shortlist
		}
	};
}
