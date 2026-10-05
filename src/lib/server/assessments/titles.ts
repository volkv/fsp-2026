// Names of specializations and grades by the catalog, for letters and screens.
import { CATALOG } from './contract/catalog';

export const specializationTitle = (key: string): string =>
	CATALOG.specializations.find((s) => s.key === key)?.title ?? key;

export const gradeTitle = (key: string): string => CATALOG.grades.find((g) => g.key === key)?.title ?? key;

/** «Backend Junior»: the test of a pair. */
export const testTitle = (specialization: string, grade: string): string =>
	`${specializationTitle(specialization)} ${gradeTitle(grade)}`;
