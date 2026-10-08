// Names of specializations by the catalog and of grades by the taxonomy, for letters and screens.
import { categoryName } from '$lib/components/product/model.js';
import { CATEGORY_GRADE_NAMES, categoryGradeName } from '$lib/server/categories/labels';
import { CATALOG } from './contract/catalog';

export const specializationTitle = (key: string): string =>
	CATALOG.specializations.find((s) => s.key === key)?.title ?? key;

export const gradeTitle = categoryGradeName;

const NAMES = {
	specializations: Object.fromEntries(CATALOG.specializations.map((s) => [s.key, s.title])),
	grades: CATEGORY_GRADE_NAMES
};

/** «Backend · Младший»: the test of a pair, named as every page names its category. */
export const testTitle = (specialization: string, grade: string): string =>
	categoryName({ specialization, grade }, NAMES);
