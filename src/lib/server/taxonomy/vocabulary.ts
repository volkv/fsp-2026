// Names of the taxonomy keys of one taxonomy version (docs/domain.md, section 11): roles, grades, skills and work terms
// as the cabinets show them. The employer and candidate vocabularies are shaped from this reading.
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { grades, roles, skills, taxonomyVersions, workFormats } from '$lib/server/db/schema';

/** The dimensions of work terms: format, employment form and contract type. */
export type TermDimension = 'work_format' | 'employment_form' | 'contract_type';

export interface NamedKey {
	key: string;
	name: string;
}

export interface TaxonomyNames {
	/** By name. */
	roles: NamedKey[];
	/** Lowest first. */
	grades: NamedKey[];
	/** By name. */
	skills: NamedKey[];
	terms: Record<TermDimension, NamedKey[]>;
}

export interface TaxonomyVersionRef {
	id: string;
	label: string;
}

const byName = (a: NamedKey, b: NamedKey) => a.name.localeCompare(b.name, 'ru');

/** The latest published taxonomy version; `null` before the first release. */
export async function latestPublishedVersion(executor: Executor): Promise<TaxonomyVersionRef | null> {
	const [version] = await executor
		.select({ id: taxonomyVersions.id, label: taxonomyVersions.label })
		.from(taxonomyVersions)
		.where(and(eq(taxonomyVersions.status, 'published'), isNotNull(taxonomyVersions.publishedAt)))
		.orderBy(desc(taxonomyVersions.publishedAt), desc(taxonomyVersions.id))
		.limit(1);
	return version ?? null;
}

/** A given taxonomy version, published or not; `null` when there is none with this id. */
export async function taxonomyVersionById(executor: Executor, id: string): Promise<TaxonomyVersionRef | null> {
	const [version] = await executor
		.select({ id: taxonomyVersions.id, label: taxonomyVersions.label })
		.from(taxonomyVersions)
		.where(eq(taxonomyVersions.id, id));
	return version ?? null;
}

export async function readTaxonomyNames(executor: Executor, taxonomyVersionId: string): Promise<TaxonomyNames> {
	const [roleRows, gradeRows, skillRows, termRows] = await Promise.all([
		executor
			.select({ key: roles.key, name: roles.nameRu })
			.from(roles)
			.where(eq(roles.taxonomyVersionId, taxonomyVersionId)),
		executor
			.select({ key: grades.key, name: grades.name })
			.from(grades)
			.where(eq(grades.taxonomyVersionId, taxonomyVersionId))
			.orderBy(asc(grades.ordinal)),
		executor
			.select({ key: skills.key, name: skills.name })
			.from(skills)
			.where(eq(skills.taxonomyVersionId, taxonomyVersionId)),
		executor
			.select({ dimension: workFormats.dimension, key: workFormats.key, name: workFormats.name })
			.from(workFormats)
			.where(eq(workFormats.taxonomyVersionId, taxonomyVersionId))
	]);
	const termsOf = (dimension: TermDimension) =>
		termRows.filter((row) => row.dimension === dimension).map(({ key, name }) => ({ key, name }));
	return {
		roles: roleRows.sort(byName),
		grades: gradeRows,
		skills: skillRows.sort(byName),
		terms: {
			work_format: termsOf('work_format'),
			employment_form: termsOf('employment_form'),
			contract_type: termsOf('contract_type')
		}
	};
}
