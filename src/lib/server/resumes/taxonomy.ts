// The taxonomy version a resume is read against (docs/domain.md, section 11): the latest published version with its
// skill aliases (normalization and quote checks) and its roles (a job title → a role key).
import { eq } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { roles, skillAliases } from '$lib/server/db/schema';
import type { SkillLexicon } from '$lib/server/ml/quotes';
import { languageNameSpellings } from '$lib/server/taxonomy/languages';
import { matchSkill, type SkillIndex } from '$lib/server/taxonomy/normalize';
import { buildSkillReader, type SkillReader } from '$lib/server/taxonomy/skill-spans';
import { latestPublishedVersion } from '$lib/server/taxonomy/vocabulary';

export interface ResumeTaxonomy {
	id: string;
	label: string;
	/**
	 * What a claim of a resume normalizes against: the spellings of the skills and the name alone of a language skill
	 * («Английский» of «Английский язык»), which a resume writes next to the level of the language.
	 */
	skills: SkillIndex;
	/** Normalized spellings of every skill in `skills`, including its name. */
	aliasesBySkill: ReadonlyMap<string, readonly string[]>;
	/**
	 * The scanner of skill mentions in the text: the spellings of the taxonomy only. The name of a language alone is a
	 * skill where the resume states the language with its level, not wherever the word stands.
	 */
	spans: SkillReader;
	roles: readonly { key: string; nameRu: string }[];
}

export function buildResumeTaxonomy(input: {
	id: string;
	label: string;
	aliases: readonly { aliasNormalized: string; skillKey: string }[];
	roles: readonly { key: string; nameRu: string }[];
}): ResumeTaxonomy {
	const claims = buildSkillReader([...input.aliases, ...languageNameSpellings(input.aliases)]);
	return {
		id: input.id,
		label: input.label,
		skills: claims.skills,
		aliasesBySkill: claims.aliasesBySkill,
		spans: buildSkillReader(input.aliases),
		roles: [...input.roles].sort((a, b) => (a.key < b.key ? -1 : 1))
	};
}

/** The latest published version; `null` before the first release. */
export async function loadResumeTaxonomy(executor: Executor): Promise<ResumeTaxonomy | null> {
	const version = await latestPublishedVersion(executor);
	if (!version) return null;
	const [aliasRows, roleRows] = await Promise.all([
		executor
			.select({ aliasNormalized: skillAliases.aliasNormalized, skillKey: skillAliases.skillKey })
			.from(skillAliases)
			.where(eq(skillAliases.taxonomyVersionId, version.id)),
		executor.select({ key: roles.key, nameRu: roles.nameRu }).from(roles).where(eq(roles.taxonomyVersionId, version.id))
	]);
	return buildResumeTaxonomy({ ...version, aliases: aliasRows, roles: roleRows });
}

/**
 * Aliases the quote of a skill is checked against, in an answer of `resume-extract/v2` and in the items of the rules
 * alike (docs/contracts.md, section 3.2).
 */
export function resumeLexicon(taxonomy: ResumeTaxonomy): SkillLexicon {
	return {
		aliasesOf: (rawText) => {
			const match = matchSkill(taxonomy.skills, rawText);
			if (match.skillKey === null) return [];
			return [...new Set([rawText, ...(taxonomy.aliasesBySkill.get(match.skillKey) ?? [])])];
		}
	};
}
