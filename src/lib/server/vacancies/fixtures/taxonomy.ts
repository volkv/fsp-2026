// The taxonomy of the repository (`taxonomy/`) as `VacancyTaxonomy`, for unit tests of reading vacancy texts.
import { fileURLToPath } from 'node:url';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { buildVacancyTaxonomy, type VacancyTaxonomy } from '../taxonomy';

const TAXONOMY_DIR = fileURLToPath(new URL('../../../../../taxonomy', import.meta.url));

export async function repositoryTaxonomy(): Promise<VacancyTaxonomy> {
	const release = buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR));
	return buildVacancyTaxonomy({
		id: 'repository',
		label: release.label,
		aliases: release.content.skillAliases.map((a) => ({ aliasNormalized: a.alias_normalized, skillKey: a.skill_key })),
		grades: release.content.grades,
		terms: release.content.workFormats,
		roles: release.content.roles.map((r) => ({ key: r.key, nameRu: r.name_ru }))
	});
}
