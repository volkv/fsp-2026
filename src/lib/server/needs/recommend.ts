// Recommended categories of a need (docs/domain.md, section 13.10). The categories of the need are the pair of the
// form, or — without a specialization — the first specialization of its role, with the neighbouring grades of its
// range offered as a deliberate widening, never taken by default. A composite role (fullstack: backend and frontend)
// offers its other specializations the same way — the employer adds them knowingly; inside the shortlist a candidate
// confirmed in every specialization of the role comes first (`compositeSpecializations`). A need whose role no
// test of the catalog checks (data engineer, systems analyst) has no category: the specializations whose blocks confirm
// its required skills are suggested with what they cover, for the employer to choose, never instead of the role. Each
// category with the number of candidates of an active category the company sees (`canShow` in the catalog and the
// predicate of the module of categories), of them with results of FSP that relate to the need; small numbers are «< 5».
// The categories are a pure function of the form; the numbers are read at the moment of the request.
import { sql } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import {
	CATALOG,
	GRADE_KEYS,
	gradeOrdinal,
	type GradeKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import { categoryPredicate } from '$lib/server/categories/read';
import { specializationsOfRole } from '$lib/server/categories/roles';
import type { Executor } from '$lib/server/db';
import { candidateAt, listedInCatalog } from '$lib/server/db/conditions';
import { candidates } from '$lib/server/db/schema';
import { candidatesWithFsp } from '$lib/server/matching/fsp-results';
import { loadCatalogViewer, loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import { smallCell, smallCountThreshold, type SmallCell } from '$lib/server/operator/small-numbers';
import { canShow } from '$lib/server/visibility/can-show';
import { gradesOf, type NeedForm, type NeedGrade } from './form';

/**
 * Why a category is offered: `form` — the pair the employer named; `role` — the specialization of the role of the
 * need; `composite_role` — another specialization of a composite role (Frontend of a fullstack), a widening;
 * `neighbour_grade` — a grade next to the range, a widening; `skills` — a suggestion by the required skills its blocks
 * confirm, for a need without a category of its own.
 */
export type RecommendationBasis = 'form' | 'role' | 'composite_role' | 'neighbour_grade' | 'skills';

export interface RecommendedCategory {
	specialization: SpecializationKey;
	grade: GradeKey;
	basis: RecommendationBasis;
	/** Required skills of the need the blocks of the specialization confirm. */
	coveredSkills: string[];
}

/**
 * Where the categories of a need come from: `form` — its specialization; `role` — the specializations of its role;
 * `unsupported_role` — its role is one no test of the catalog checks; `closed` — the specialization of the form or of
 * the role is not open now; `no_basis` — the need names neither a role nor a specialization.
 */
export type CategoryBasis = 'form' | 'role' | 'unsupported_role' | 'closed' | 'no_basis';

export interface NeedCategories {
	basis: CategoryBasis;
	/** The categories of the need and their neighbouring grades, then the suggestions by skills. */
	categories: RecommendedCategory[];
	/** Specializations of the form or the role that are closed now. */
	closed: SpecializationKey[];
}

/** The grades just below and just above the range. */
function neighbours(range: NeedGrade): GradeKey[] {
	const low = gradeOrdinal(range.min) - 1;
	const high = gradeOrdinal(range.max) + 1;
	return GRADE_KEYS.filter((key) => gradeOrdinal(key) === low || gradeOrdinal(key) === high);
}

function coveredBy(specialization: SpecializationKey, skills: readonly string[]): string[] {
	const confirmed = new Set(
		CATALOG.blocks.filter((block) => block.specialization === specialization).flatMap((block) => block.skillKeys)
	);
	return skills.filter((skill) => confirmed.has(skill));
}

/**
 * The categories of one specialization: every grade of the range of the form and the neighbours of the range, or every
 * grade without a range. Suggestions by skills take no neighbours: they are a choice already.
 */
function categoriesOf(
	specialization: SpecializationKey,
	range: NeedGrade | undefined,
	basis: 'form' | 'role' | 'composite_role' | 'skills',
	covered: string[]
): RecommendedCategory[] {
	if (range === undefined)
		return GRADE_KEYS.map((key) => ({ specialization, grade: key, basis, coveredSkills: covered }));
	const own = gradesOf(range).map((grade) => ({ specialization, grade, basis, coveredSkills: covered }));
	if (basis === 'skills' || basis === 'composite_role') return own;
	return [
		...own,
		...neighbours(range).map((key) => ({
			specialization,
			grade: key,
			basis: 'neighbour_grade' as const,
			coveredSkills: covered
		}))
	];
}

/** Open specializations whose blocks confirm a required skill of the need, the most covered first. */
function bySkills(form: NeedForm, open: ReadonlySet<SpecializationKey>): RecommendedCategory[] {
	return [...open]
		.map((specialization) => ({ specialization, covered: coveredBy(specialization, form.skill_keys) }))
		.filter(({ covered }) => covered.length > 0)
		.sort((a, b) => b.covered.length - a.covered.length || a.specialization.localeCompare(b.specialization))
		.flatMap(({ specialization, covered }) => categoriesOf(specialization, form.grade, 'skills', covered));
}

/**
 * The specializations of a composite role of the need (fullstack: backend and frontend); empty for a role of one or
 * none. A candidate confirmed in all of them covers the whole work of the role.
 */
export function compositeSpecializations(form: NeedForm): SpecializationKey[] {
	if (form.role_key === undefined) return [];
	const specializations = specializationsOfRole(form.role_key);
	return specializations.length > 1 ? [...specializations] : [];
}

/**
 * The categories of the form among the open specializations: the specialization of the form, else the first open one
 * of its role, with its neighbouring grades; the other open specializations of a composite role as offers. A need
 * without an open category of its own gets suggestions by its required skills; nothing to go by gives no categories.
 */
export function needCategoriesOf(form: NeedForm, open: ReadonlySet<SpecializationKey>): NeedCategories {
	const own = (basis: 'form' | 'role', specializations: readonly SpecializationKey[]): NeedCategories => {
		const [first, ...others] = specializations.filter((s) => open.has(s));
		const closed = specializations.filter((s) => !open.has(s));
		if (first === undefined) return { basis: 'closed', categories: bySkills(form, open), closed };
		return {
			basis,
			categories: [
				...categoriesOf(first, form.grade, basis, coveredBy(first, form.skill_keys)),
				...others.flatMap((s) => categoriesOf(s, form.grade, 'composite_role', coveredBy(s, form.skill_keys)))
			],
			closed
		};
	};
	if (form.specialization !== undefined) return own('form', [form.specialization]);
	if (form.role_key !== undefined) {
		const specializations = specializationsOfRole(form.role_key);
		if (specializations.length > 0) return own('role', specializations);
		return { basis: 'unsupported_role', categories: bySkills(form, open), closed: [] };
	}
	return { basis: 'no_basis', categories: bySkills(form, open), closed: [] };
}

/** The recommended categories of the form, in the order of `needCategoriesOf`. */
export function recommendCategories(form: NeedForm, open: ReadonlySet<SpecializationKey>): RecommendedCategory[] {
	return needCategoriesOf(form, open).categories;
}

/** The numbers of a category for the company. */
export interface CategoryCounts {
	/** Candidates of an active category of the pair the company sees in the catalog. */
	candidates: SmallCell;
	/** Of them, with an FSP result (`candidatesWithFsp`): the same as the shortlist's label and filter «только с ФСП». */
	withFsp: SmallCell;
}

export type CountedCategory = RecommendedCategory & CategoryCounts;

/**
 * Categories with their numbers for the subject's company: candidates of a category in force by the predicate of the
 * module of categories, then `canShow` in the catalog of the company; `exclude` — candidates not to count (those a
 * shortlist already shows).
 */
export async function countCategories<T extends { specialization: SpecializationKey; grade: GradeKey }>(
	executor: Executor,
	subject: AccessSubject,
	categories: readonly T[],
	now: Date,
	exclude: ReadonlySet<string> = new Set()
): Promise<(T & CategoryCounts)[]> {
	if (categories.length === 0) return [];
	const viewer = await loadCatalogViewer(executor, subject, now);
	if (!viewer) throw new Error('categories are counted for a member of a company');
	const c = candidateAt('c');
	const members = new Map<string, Set<string>>();
	for (const category of categories) {
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
			if (exclude.has(id)) return false;
			const candidate = facts.get(id);
			return candidate !== undefined && canShow(candidate, viewer.viewer, { kind: 'catalog' }).allowed;
		})
	);
	const fsp = await candidatesWithFsp(executor, [...visible]);
	const threshold = await smallCountThreshold(executor, now);
	return categories.map((category) => {
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
