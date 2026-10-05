// Recommended categories of a need (docs/domain.md, section 13.10): the pair of the form and the neighbouring grades of
// its specialization; without a specialization — the specializations whose blocks confirm the required skills of the
// need. Each with the number of candidates of an active category the company sees (`canShow` in the catalog and the
// predicate of the module of categories), of them with results of FSP that relate to the need; small numbers are
// «< 5». The categories are a pure function of the form; the numbers are read at the moment of the request.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import {
	CATALOG,
	GRADE_KEYS,
	gradeOrdinal,
	type GradeKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import { categoryPredicate } from '$lib/server/categories/read';
import type { Executor } from '$lib/server/db';
import { candidateAt, listedInCatalog } from '$lib/server/db/conditions';
import { candidates, skillInferences, sourceFacts } from '$lib/server/db/schema';
import { loadCatalogViewer, loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import { smallCell, smallCountThreshold, type SmallCell } from '$lib/server/operator/small-numbers';
import { canShow } from '$lib/server/visibility/can-show';
import type { NeedForm } from './form';

export type RecommendationBasis = 'form' | 'neighbour_grade' | 'skills';

export interface RecommendedCategory {
	specialization: SpecializationKey;
	grade: GradeKey;
	basis: RecommendationBasis;
	/** Required skills of the need the blocks of the specialization confirm. */
	coveredSkills: string[];
}

function neighbours(grade: GradeKey): GradeKey[] {
	const ordinal = gradeOrdinal(grade);
	return GRADE_KEYS.filter((key) => Math.abs(gradeOrdinal(key) - ordinal) === 1);
}

function coveredBy(specialization: SpecializationKey, skills: readonly string[]): string[] {
	const confirmed = new Set(
		CATALOG.blocks.filter((block) => block.specialization === specialization).flatMap((block) => block.skillKeys)
	);
	return skills.filter((skill) => confirmed.has(skill));
}

/** The categories of one specialization: the grade of the form and its neighbours, or every grade without one. */
function categoriesOf(
	specialization: SpecializationKey,
	grade: GradeKey | undefined,
	basis: 'form' | 'skills',
	covered: string[]
): RecommendedCategory[] {
	if (grade === undefined)
		return GRADE_KEYS.map((key) => ({ specialization, grade: key, basis, coveredSkills: covered }));
	return [
		{ specialization, grade, basis, coveredSkills: covered },
		...neighbours(grade).map((key) => ({
			specialization,
			grade: key,
			basis: 'neighbour_grade' as const,
			coveredSkills: covered
		}))
	];
}

/**
 * The categories recommended for the form, among the open specializations: the pair of the form and its neighbouring
 * grades; without a specialization, the specializations confirming the most required skills first. Nothing to go by —
 * no specialization and no skill a block confirms — gives no categories.
 */
export function recommendCategories(form: NeedForm, open: ReadonlySet<SpecializationKey>): RecommendedCategory[] {
	if (form.specialization !== undefined) {
		if (!open.has(form.specialization)) return [];
		return categoriesOf(form.specialization, form.grade, 'form', coveredBy(form.specialization, form.skill_keys));
	}
	return [...open]
		.map((specialization) => ({ specialization, covered: coveredBy(specialization, form.skill_keys) }))
		.filter(({ covered }) => covered.length > 0)
		.sort((a, b) => b.covered.length - a.covered.length || a.specialization.localeCompare(b.specialization))
		.flatMap(({ specialization, covered }) => categoriesOf(specialization, form.grade, 'skills', covered));
}

export interface CountedCategory extends RecommendedCategory {
	/** Candidates of an active category of the pair the company sees in the catalog. */
	candidates: SmallCell;
	/** Of them, with an active result of FSP that relates to the need. */
	withFsp: SmallCell;
}

/**
 * Candidates with an active result of FSP relating to the need: an FSP fact in force and, when the need names required
 * skills, one of them confirmed directly by FSP.
 */
async function withRelevantFsp(
	executor: Executor,
	candidateIds: readonly string[],
	form: NeedForm
): Promise<Set<string>> {
	if (candidateIds.length === 0) return new Set();
	const skills = form.skill_keys;
	const rows = await executor
		.selectDistinct({ id: sourceFacts.candidateId })
		.from(sourceFacts)
		.where(
			and(
				inArray(sourceFacts.candidateId, [...candidateIds]),
				eq(sourceFacts.source, 'fsp'),
				eq(sourceFacts.status, 'active'),
				skills.length === 0
					? undefined
					: sql`exists (select 1 from ${skillInferences} si where si.candidate_id = ${sourceFacts.candidateId}
						and si.badge_trust = 'fsp_verified' and si.skill_key in ${skills})`
			)
		);
	return new Set(rows.map((row) => row.id));
}

/**
 * The recommended categories of the form with their numbers for the subject's company: candidates of a category in
 * force by the predicate of the module of categories, then `canShow` in the catalog of the company.
 */
export async function countRecommendedCategories(
	executor: Executor,
	subject: AccessSubject,
	form: NeedForm,
	open: ReadonlySet<SpecializationKey>,
	now: Date
): Promise<CountedCategory[]> {
	const recommended = recommendCategories(form, open);
	if (recommended.length === 0) return [];
	const viewer = await loadCatalogViewer(executor, subject, now);
	if (!viewer) throw new Error('recommended categories are counted for a member of a company');
	const c = candidateAt('c');
	const members = new Map<string, Set<string>>();
	for (const category of recommended) {
		const rows = await executor.execute<{ id: string }>(
			sql`select c.id from ${candidates} c where ${listedInCatalog(c)}
				and ${categoryPredicate(sql`c.id`, { specializations: [category.specialization], grades: [category.grade] })}`
		);
		members.set(`${category.specialization}:${category.grade}`, new Set(rows.map((row) => row.id)));
	}
	const all = [...new Set([...members.values()].flatMap((ids) => [...ids]))];
	const facts = await loadVisibilityFacts(executor, all, {
		now,
		policy: await loadVisibilityPolicy(executor, now),
		viewerCompanyId: viewer.viewer.companyId,
		viewerCompany: viewer.company
	});
	const visible = new Set(
		all.filter((id) => {
			const candidate = facts.get(id);
			return candidate !== undefined && canShow(candidate, viewer.viewer, { kind: 'catalog' }).allowed;
		})
	);
	const fsp = await withRelevantFsp(executor, [...visible], form);
	const threshold = await smallCountThreshold(executor, now);
	return recommended.map((category) => {
		const ids = [...(members.get(`${category.specialization}:${category.grade}`) ?? [])].filter((id) =>
			visible.has(id)
		);
		return {
			...category,
			candidates: smallCell(ids.length, threshold),
			withFsp: smallCell(ids.filter((id) => fsp.has(id)).length, threshold)
		};
	});
}
