// Names of the taxonomy keys an employer sees (docs/domain.md, section 11): roles, grades, skills and work terms of one
// taxonomy version, for the forms and the labels of the employer cabinet. The interface never prints a raw key where
// the taxonomy has a name for it.
import { CATEGORY_OPTIONS } from '$lib/server/categories/labels';
import type { Executor } from '$lib/server/db';
import {
	latestPublishedVersion,
	readTaxonomyNames,
	type NamedKey,
	type TaxonomyNames,
	type TermDimension
} from '$lib/server/taxonomy/vocabulary';
import { TaxonomyUnavailable } from '$lib/server/vacancies/taxonomy';

export interface Vocabulary extends TaxonomyNames {
	taxonomyVersionId: string;
}

/** The latest published taxonomy version: new vacancies are written against it. */
export async function currentVocabulary(executor: Executor): Promise<Vocabulary> {
	const version = await latestPublishedVersion(executor);
	if (!version) throw new TaxonomyUnavailable('no published taxonomy version');
	return vocabularyOf(executor, version.id);
}

/** The version a stored vacancy or run was written with. */
export async function vocabularyOf(executor: Executor, taxonomyVersionId: string): Promise<Vocabulary> {
	return { taxonomyVersionId, ...(await readTaxonomyNames(executor, taxonomyVersionId)) };
}

/** Key → name maps of a vocabulary, as plain records the pages receive. */
export interface Labels {
	roles: Record<string, string>;
	/** Specializations of the catalog of categories (domain 12.1). */
	specializations: Record<string, string>;
	grades: Record<string, string>;
	skills: Record<string, string>;
	terms: Record<TermDimension, Record<string, string>>;
}

export function labelsOf(vocabulary: Vocabulary): Labels {
	const record = (list: readonly NamedKey[]) => Object.fromEntries(list.map(({ key, name }) => [key, name]));
	return {
		roles: record(vocabulary.roles),
		specializations: record(CATEGORY_OPTIONS.specializations),
		grades: record(vocabulary.grades),
		skills: record(vocabulary.skills),
		terms: {
			work_format: record(vocabulary.terms.work_format),
			employment_form: record(vocabulary.terms.employment_form),
			contract_type: record(vocabulary.terms.contract_type)
		}
	};
}

/** What a vacancy form offers: roles, grades and work terms by name. */
export function formVocabulary(vocabulary: Vocabulary): Pick<Vocabulary, 'roles' | 'grades' | 'terms'> {
	return { roles: vocabulary.roles, grades: vocabulary.grades, terms: vocabulary.terms };
}
