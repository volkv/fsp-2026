// The words of the catalog of categories for the interface (docs/domain.md, section 12.1): the specializations and the
// grades a category is made of, as the pages offer and name them.
import {
	CATALOG,
	GRADE_KEYS,
	SPECIALIZATION_KEYS,
	type GradeKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import type { NamedKey } from '$lib/server/taxonomy/vocabulary';

export interface CategoryOptions {
	specializations: NamedKey[];
	grades: NamedKey[];
}

/** Every specialization and grade of the current catalog, in its order. */
export const CATEGORY_OPTIONS: CategoryOptions = {
	specializations: CATALOG.specializations.map((s) => ({ key: s.key, name: s.title })),
	grades: CATALOG.grades.map((g) => ({ key: g.key, name: g.title }))
};

/** A key of the address or a form is a specialization of the catalog. */
export const isSpecializationKey = (key: string): key is SpecializationKey =>
	(SPECIALIZATION_KEYS as readonly string[]).includes(key);

/** A key of the address or a form is a grade of the catalog. */
export const isGradeKey = (key: string): key is GradeKey => (GRADE_KEYS as readonly string[]).includes(key);
