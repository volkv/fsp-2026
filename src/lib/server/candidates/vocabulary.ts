// Names of the taxonomy keys the candidate cabinet shows (docs/domain.md, section 11): roles, grades, skills and work
// terms of one taxonomy version. The cabinet never prints a raw key where the taxonomy has a name for it.
import type { Executor } from '$lib/server/db';
import {
	latestPublishedVersion,
	readTaxonomyNames,
	taxonomyVersionById,
	type NamedKey,
	type TaxonomyVersionRef
} from '$lib/server/taxonomy/vocabulary';

export interface CandidateVocabulary {
	taxonomyVersionId: string;
	taxonomyLabel: string;
	roles: NamedKey[];
	/** Lowest first. */
	grades: NamedKey[];
	skills: NamedKey[];
	workFormats: NamedKey[];
	employmentForms: NamedKey[];
}

/** Key → name records of a vocabulary, as the pages receive them. */
export interface VocabularyLabels {
	roles: Record<string, string>;
	grades: Record<string, string>;
	skills: Record<string, string>;
	workFormats: Record<string, string>;
	employmentForms: Record<string, string>;
}

async function content(executor: Executor, version: TaxonomyVersionRef): Promise<CandidateVocabulary> {
	const names = await readTaxonomyNames(executor, version.id);
	return {
		taxonomyVersionId: version.id,
		taxonomyLabel: version.label,
		roles: names.roles,
		grades: names.grades,
		skills: names.skills,
		workFormats: names.terms.work_format,
		employmentForms: names.terms.employment_form
	};
}

/** The latest published taxonomy version; `null` before the first release. */
export async function currentCandidateVocabulary(executor: Executor): Promise<CandidateVocabulary | null> {
	const version = await latestPublishedVersion(executor);
	return version ? content(executor, version) : null;
}

/** The version a stored run or vacancy was written with. */
export async function candidateVocabularyOf(
	executor: Executor,
	taxonomyVersionId: string
): Promise<CandidateVocabulary> {
	const version = await taxonomyVersionById(executor, taxonomyVersionId);
	if (!version) throw new Error(`taxonomy version ${taxonomyVersionId} does not exist`);
	return content(executor, version);
}

export function vocabularyLabels(vocabulary: CandidateVocabulary | null): VocabularyLabels {
	const record = (list: readonly NamedKey[] | undefined) =>
		Object.fromEntries((list ?? []).map(({ key, name }) => [key, name]));
	return {
		roles: record(vocabulary?.roles),
		grades: record(vocabulary?.grades),
		skills: record(vocabulary?.skills),
		workFormats: record(vocabulary?.workFormats),
		employmentForms: record(vocabulary?.employmentForms)
	};
}
