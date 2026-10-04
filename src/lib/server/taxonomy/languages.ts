// Natural languages among the skills of the taxonomy (docs/domain.md, section 11). A language skill is named
// «<язык> язык» («Английский язык»); a resume writes the language by its name alone next to its level
// («Английский — B2»), and that name stands for the skill.
import type { SkillAlias } from './normalize';

/** A normalized spelling «<name> язык»: the name of a language followed by the word for language. */
const LANGUAGE_SPELLING = /^(\p{L}+) язык$/u;

/**
 * The name alone of every language skill, as a spelling of that skill. A name that already spells another skill stays
 * that skill's: the taxonomy's own spellings come first.
 */
export function languageNameSpellings(aliases: readonly SkillAlias[]): SkillAlias[] {
	const owners = new Map(aliases.map(({ aliasNormalized, skillKey }) => [aliasNormalized, skillKey]));
	const found: SkillAlias[] = [];
	for (const { aliasNormalized, skillKey } of aliases) {
		const name = LANGUAGE_SPELLING.exec(aliasNormalized)?.[1];
		if (name === undefined || owners.has(name)) continue;
		owners.set(name, skillKey);
		found.push({ aliasNormalized: name, skillKey });
	}
	return found;
}
