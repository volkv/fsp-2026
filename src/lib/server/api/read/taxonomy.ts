// Dictionaries of the active taxonomy version (docs/domain.md, section 11): the latest published one, the same version
// vacancies are normalized with.
import { asc, eq } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { grades, roles, skillAliases, skills, workFormats } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { latestPublishedVersion, type TaxonomyVersionRef } from '$lib/server/taxonomy/vocabulary';

/** Without a published version the dictionaries do not exist yet: the service is not ready (`503`). */
export async function activeTaxonomyVersion(executor: Executor): Promise<TaxonomyVersionRef> {
	const version = await latestPublishedVersion(executor);
	if (!version) throw new ApiError('degraded', { message: 'Справочники ещё не опубликованы', retryAfterSeconds: 60 });
	return version;
}

export async function listRoles(executor: Executor, versionId: string) {
	return executor
		.select({ key: roles.key, family: roles.family, name: roles.nameRu })
		.from(roles)
		.where(eq(roles.taxonomyVersionId, versionId))
		.orderBy(asc(roles.family), asc(roles.key));
}

export async function listSkills(executor: Executor, versionId: string) {
	const rows = await executor
		.select({ key: skills.key, kind: skills.kind, parentKey: skills.parentKey, name: skills.name })
		.from(skills)
		.where(eq(skills.taxonomyVersionId, versionId))
		.orderBy(asc(skills.key));
	const aliases = await executor
		.select({ skillKey: skillAliases.skillKey, alias: skillAliases.aliasNormalized })
		.from(skillAliases)
		.where(eq(skillAliases.taxonomyVersionId, versionId))
		.orderBy(asc(skillAliases.aliasNormalized));
	const aliasesOf = new Map<string, string[]>();
	for (const { skillKey, alias } of aliases) aliasesOf.set(skillKey, [...(aliasesOf.get(skillKey) ?? []), alias]);
	return rows.map((row) => ({ ...row, aliases: aliasesOf.get(row.key) ?? [] }));
}

export async function listGrades(executor: Executor, versionId: string) {
	return executor
		.select({ key: grades.key, ordinal: grades.ordinal, name: grades.name })
		.from(grades)
		.where(eq(grades.taxonomyVersionId, versionId))
		.orderBy(asc(grades.ordinal));
}

export async function listWorkTerms(executor: Executor, versionId: string) {
	return executor
		.select({ dimension: workFormats.dimension, key: workFormats.key, name: workFormats.name })
		.from(workFormats)
		.where(eq(workFormats.taxonomyVersionId, versionId))
		.orderBy(asc(workFormats.dimension), asc(workFormats.key));
}
