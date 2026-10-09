// The words of the catalog of categories for the interface (docs/domain.md, section 12.1): the specializations and the
// grades a category is made of, as the pages offer and name them. A grade of a category is named by the taxonomy — the
// scale of grades every page reads (`taxonomy/grades.json`, the dataset each start publishes) — the same name in the
// shortlist, the offer, the catalog, the screens of the tests and the letters; the catalog of tests has keys, not words.
import taxonomyGrades from '../../../../taxonomy/grades.json' with { type: 'json' };
import {
	CATALOG,
	GRADE_KEYS,
	SPECIALIZATION_KEYS,
	type GradeKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import type { NamedKey } from '$lib/server/taxonomy/vocabulary';

function categoryGradeNames(): Readonly<Record<GradeKey, string>> {
	const names = new Map(taxonomyGrades.grades.map((grade) => [grade.key, grade.name]));
	return Object.fromEntries(
		GRADE_KEYS.map((key) => {
			const name = names.get(key);
			if (name === undefined) throw new Error(`the taxonomy has no grade ${key} of the catalog of categories`);
			return [key, name];
		})
	) as Record<GradeKey, string>;
}

/** The name of each grade of a category, by the taxonomy. */
export const CATEGORY_GRADE_NAMES = categoryGradeNames();

/** The name of a grade of a category; a key outside the catalog stays as it is. */
export const categoryGradeName = (key: string): string => (isGradeKey(key) ? CATEGORY_GRADE_NAMES[key] : key);

export interface CategoryOptions {
	specializations: NamedKey[];
	grades: NamedKey[];
}

/** Every specialization and grade of the current catalog, in its order. */
export const CATEGORY_OPTIONS: CategoryOptions = {
	specializations: CATALOG.specializations.map((s) => ({ key: s.key, name: s.title })),
	grades: GRADE_KEYS.map((key) => ({ key, name: CATEGORY_GRADE_NAMES[key] }))
};

/** A key of the address or a form is a specialization of the catalog. */
export const isSpecializationKey = (key: string): key is SpecializationKey =>
	(SPECIALIZATION_KEYS as readonly string[]).includes(key);

/** A key of the address or a form is a grade of the catalog. */
export function isGradeKey(key: string): key is GradeKey {
	return (GRADE_KEYS as readonly string[]).includes(key);
}
