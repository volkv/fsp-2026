// The taxonomy version vacancy texts and forms are read against (docs/domain.md, section 11): the latest published
// version with its skill index, grade scale, work format keys and roles.
import { eq } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { grades, roles, skillAliases, workFormats } from '$lib/server/db/schema';
import type { VacancyLexicon } from '$lib/server/ml/vacancy-extract';
import { buildSkillIndex, matchSkill, normalizeSkillText, type SkillIndex } from '$lib/server/taxonomy/normalize';
import type { RoleName } from '$lib/server/taxonomy/roles';
import { latestPublishedVersion, type TaxonomyVersionRef, type TermDimension } from '$lib/server/taxonomy/vocabulary';

export interface VacancyTaxonomy {
	id: string;
	label: string;
	skills: SkillIndex;
	/** Aliases with the spaces removed → skill, for tags written without spaces (`#Базыданных`); ambiguous ones dropped. */
	compactAliases: ReadonlyMap<string, string>;
	aliasesBySkill: ReadonlyMap<string, readonly string[]>;
	/** Grade keys, lowest first. */
	grades: readonly string[];
	terms: Readonly<Record<TermDimension, readonly string[]>>;
	roles: ReadonlySet<string>;
	/** Roles with their names, for the title rules (`roleOfTitle`). */
	roleNames: readonly RoleName[];
}

export class TaxonomyUnavailable extends Error {
	override name = 'TaxonomyUnavailable';
}

const compact = (text: string) => text.replace(/\s+/gu, '');

export function buildVacancyTaxonomy(input: {
	id: string;
	label: string;
	aliases: readonly { aliasNormalized: string; skillKey: string }[];
	grades: readonly { key: string; ordinal: number }[];
	terms: readonly { dimension: string; key: string }[];
	roles: readonly RoleName[];
}): VacancyTaxonomy {
	const aliasesBySkill = new Map<string, string[]>();
	const compactOwners = new Map<string, Set<string>>();
	for (const { aliasNormalized, skillKey } of input.aliases) {
		const list = aliasesBySkill.get(skillKey) ?? [];
		list.push(aliasNormalized);
		aliasesBySkill.set(skillKey, list);
		const key = compact(aliasNormalized);
		const owners = compactOwners.get(key) ?? new Set<string>();
		owners.add(skillKey);
		compactOwners.set(key, owners);
	}
	const compactAliases = new Map<string, string>();
	for (const [alias, owners] of compactOwners) {
		const [only] = owners;
		if (owners.size === 1 && only !== undefined) compactAliases.set(alias, only);
	}
	const termsOf = (dimension: TermDimension) => input.terms.filter((t) => t.dimension === dimension).map((t) => t.key);
	return {
		id: input.id,
		label: input.label,
		skills: buildSkillIndex(input.aliases),
		compactAliases,
		aliasesBySkill,
		grades: [...input.grades].sort((a, b) => a.ordinal - b.ordinal).map((g) => g.key),
		terms: {
			work_format: termsOf('work_format'),
			employment_form: termsOf('employment_form'),
			contract_type: termsOf('contract_type')
		},
		roles: new Set(input.roles.map((role) => role.key)),
		roleNames: input.roles
	};
}

async function versionContent(executor: Executor, version: TaxonomyVersionRef): Promise<VacancyTaxonomy> {
	const [aliasRows, gradeRows, termRows, roleRows] = await Promise.all([
		executor
			.select({ aliasNormalized: skillAliases.aliasNormalized, skillKey: skillAliases.skillKey })
			.from(skillAliases)
			.where(eq(skillAliases.taxonomyVersionId, version.id)),
		executor
			.select({ key: grades.key, ordinal: grades.ordinal })
			.from(grades)
			.where(eq(grades.taxonomyVersionId, version.id)),
		executor
			.select({ dimension: workFormats.dimension, key: workFormats.key })
			.from(workFormats)
			.where(eq(workFormats.taxonomyVersionId, version.id)),
		executor.select({ key: roles.key, nameRu: roles.nameRu }).from(roles).where(eq(roles.taxonomyVersionId, version.id))
	]);
	return buildVacancyTaxonomy({
		...version,
		aliases: aliasRows,
		grades: gradeRows,
		terms: termRows,
		roles: roleRows
	});
}

/** The latest published taxonomy version; without one a vacancy cannot be read or checked. */
export async function loadVacancyTaxonomy(executor: Executor): Promise<VacancyTaxonomy> {
	const version = await latestPublishedVersion(executor);
	if (!version) throw new TaxonomyUnavailable('no published taxonomy version');
	return versionContent(executor, version);
}

/** A skill mention → canonical key: exact or fuzzy alias, then the alias written without spaces. */
export function resolveSkill(taxonomy: VacancyTaxonomy, raw: string): string | null {
	const match = matchSkill(taxonomy.skills, raw);
	if (match.skillKey !== null) return match.skillKey;
	return taxonomy.compactAliases.get(compact(normalizeSkillText(raw))) ?? null;
}

/** The keys `vacancy-extract/v1` may use and the aliases its quotes are checked against (contracts 3.2). */
export function vacancyLexicon(taxonomy: VacancyTaxonomy): VacancyLexicon {
	return {
		grades: taxonomy.grades,
		terms: taxonomy.terms,
		aliasesOf: (rawText) => {
			const key = resolveSkill(taxonomy, rawText);
			if (key === null) return [];
			return [...new Set([rawText, ...(taxonomy.aliasesBySkill.get(key) ?? [])])];
		}
	};
}
