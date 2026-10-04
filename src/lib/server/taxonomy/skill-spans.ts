// Skill mentions of a text by the aliases of one taxonomy version (docs/domain.md, section 11): the one scanner the
// rules of resumes and of pasted vacancies read skills with.
import { buildSkillIndex, matchSkill, normalizeSkillText, type SkillAlias, type SkillIndex } from './normalize';

/**
 * A word of a skill name: a run of letters, digits, `+` and `#`, with inner dots (`Next.js`, `.NET`). Names of several
 * words are joined by spaces, hyphens or slashes (`CI/CD`).
 */
export const SKILL_TOKEN = /\.?[\p{L}\p{N}+#]+(?:\.[\p{L}\p{N}+#]+)*/gu;

export interface Shortening {
	dropsLeading: boolean;
	dropsTrailing: boolean;
}

/** The aliases of a taxonomy version in the shape the scanner reads them. */
export interface SkillReader {
	skills: SkillIndex;
	/** Normalized aliases of every skill, including its name. */
	aliasesBySkill: ReadonlyMap<string, readonly string[]>;
	/** The longest alias in words (`SKILL_TOKEN`): how far the scanner looks ahead. */
	maxAliasWords: number;
	/**
	 * Aliases that are a shortened name of their skill: `compose` of `jetpack compose` drops the leading word, `ui` of
	 * `ui дизайн` the trailing one. Where the dropped word stands, another word makes it a different name.
	 */
	shortenings: ReadonlyMap<string, Shortening>;
}

const wordsOf = (alias: string) => alias.match(SKILL_TOKEN) ?? [];

function shorteningsOf(aliasesBySkill: ReadonlyMap<string, readonly string[]>): Map<string, Shortening> {
	const found = new Map<string, Shortening>();
	for (const aliases of aliasesBySkill.values()) {
		for (const alias of aliases) {
			const words = wordsOf(alias);
			let dropsLeading = false;
			let dropsTrailing = false;
			for (const longer of aliases) {
				const longerWords = wordsOf(longer);
				if (longerWords.length <= words.length) continue;
				const same = (offset: number) => words.every((word, i) => longerWords[offset + i] === word);
				dropsTrailing ||= same(0);
				dropsLeading ||= same(longerWords.length - words.length);
			}
			if (dropsLeading || dropsTrailing) found.set(alias, { dropsLeading, dropsTrailing });
		}
	}
	return found;
}

export function buildSkillReader(aliases: readonly SkillAlias[]): SkillReader {
	const aliasesBySkill = new Map<string, string[]>();
	let maxAliasWords = 1;
	for (const { aliasNormalized, skillKey } of aliases) {
		aliasesBySkill.set(skillKey, [...(aliasesBySkill.get(skillKey) ?? []), aliasNormalized]);
		maxAliasWords = Math.max(maxAliasWords, wordsOf(aliasNormalized).length);
	}
	return {
		skills: buildSkillIndex(aliases),
		aliasesBySkill,
		maxAliasWords,
		shortenings: shorteningsOf(aliasesBySkill)
	};
}

const JOINER = /^[ \t\-‐-―/_]{1,3}$/u;
/** Words of one name: a space or a hyphen between them, no punctuation. */
const NAME_JOINER = /^(?:[ \t]+|[-‐‑])$/u;
/** A compound word: a hyphen with nothing around it («UI-тесты»). */
const COMPOUND_JOINER = /^[-‐‑]$/u;
/** Aliases this short are taken only as written in a skills list: `Go`, `R`, `C#`, not the Russian word «го». */
const SHORT_ALIAS = 2;
const SHORT_SURFACE = /^[A-Z][A-Za-z+#]?$|^[A-Za-z][+#]{1,2}$/u;
/**
 * A word in Latin script, which is how tool names are written. Only such a word is matched fuzzily: a Russian word is
 * inflected, and its forms fall within the typo distance of unrelated aliases («мониторинга», «работы»).
 */
const LATIN_WORD = /^[\p{Script=Latin}\p{N}.+#]*\p{Script=Latin}[\p{Script=Latin}\p{N}.+#]*$/u;

interface Token {
	start: number;
	end: number;
}

export interface SkillSpan {
	text: string;
	/** UTF-16 offset in the text. */
	start: number;
}

/**
 * Skill mentions of a text: the longest alias at each place, as written in the text, or a single misspelled name. A
 * line break separates names — a list written one name per line — unless the text is one entry wrapped onto several
 * lines (`wrapped`), where it is a space.
 */
export function skillSpans(source: string, reader: SkillReader, wrapped: boolean): SkillSpan[] {
	// The same length as the source: offsets and surfaces are the source's.
	const text = wrapped ? source.replaceAll('\n', ' ') : source;
	const tokens: Token[] = Array.from(text.matchAll(SKILL_TOKEN), (m) => ({
		start: m.index,
		end: m.index + m[0].length
	}));
	const spanOf = (first: Token, last: Token): SkillSpan => ({
		text: source.slice(first.start, last.end),
		start: first.start
	});
	const surfaceAt = (i: number) => {
		const token = tokens[i];
		return token ? source.slice(token.start, token.end) : null;
	};
	/** Whether the word at `j` is written together with its neighbour at `j + 1` as words of one name. */
	const nameJoined = (j: number) => {
		const [left, right] = [tokens[j], tokens[j + 1]];
		if (!left || !right) return false;
		const words = [surfaceAt(j), surfaceAt(j + 1)];
		return NAME_JOINER.test(text.slice(left.end, right.start)) && words.every((w) => w !== null && LATIN_WORD.test(w));
	};

	/**
	 * A shortened name stands for its skill only on its own. «Docker Compose» puts another tool's name where «Jetpack
	 * Compose» has its first word; «UI-тесты» makes a two-letter shortening of «UI-дизайн» a part of a compound word.
	 */
	const partOfOtherName = (i: number, n: number, skillKey: string, normalized: string): boolean => {
		const shortening = reader.shortenings.get(normalized);
		if (!shortening) return false;
		const before = surfaceAt(i - 1);
		if (shortening.dropsLeading && before !== null && nameJoined(i - 1)) {
			const owner = reader.skills.exact.get(normalizeSkillText(before));
			if (owner !== undefined && owner !== skillKey) return true;
		}
		const [last, next] = [tokens[i + n - 1], tokens[i + n]];
		return (
			shortening.dropsTrailing &&
			Array.from(normalized).length <= SHORT_ALIAS &&
			last !== undefined &&
			next !== undefined &&
			COMPOUND_JOINER.test(text.slice(last.end, next.start))
		);
	};

	const found: SkillSpan[] = [];
	let i = 0;
	while (i < tokens.length) {
		const first = tokens[i];
		if (!first) break;
		let matched = 0;
		for (let n = Math.min(reader.maxAliasWords, tokens.length - i); n >= 1; n--) {
			const last = tokens[i + n - 1];
			if (!last) break;
			const gapsJoin = tokens
				.slice(i, i + n - 1)
				.every((token, k) => JOINER.test(text.slice(token.end, tokens[i + k + 1]?.start)));
			if (!gapsJoin) continue;
			const surface = text.slice(first.start, last.end);
			const normalized = normalizeSkillText(surface);
			const skillKey = reader.skills.exact.get(normalized);
			if (skillKey === undefined) continue;
			if (Array.from(normalized).length <= SHORT_ALIAS && !SHORT_SURFACE.test(surface)) continue;
			// The words are taken either way: a part of another name is a mention of nothing.
			matched = n;
			if (!partOfOtherName(i, n, skillKey, normalized)) found.push(spanOf(first, last));
			break;
		}
		if (matched === 0) {
			// A misspelled name («Kuberentes») is taken when it stands alone and exactly one skill is close enough to it;
			// a word of a longer phrase («Manual testing») is ordinary language, not a name.
			const surface = source.slice(first.start, first.end);
			const alone = !nameJoined(i - 1) && !nameJoined(i);
			if (LATIN_WORD.test(surface) && alone && matchSkill(reader.skills, surface).method === 'fuzzy') {
				found.push(spanOf(first, first));
			}
		}
		i += Math.max(matched, 1);
	}
	return found;
}
