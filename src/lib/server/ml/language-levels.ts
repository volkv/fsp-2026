// Levels of a spoken language in a resume (docs/contracts.md, section 3.2): the list the model answers with and the
// ways resumes write each level, which the quote of a level is checked against.
import { fold } from './quotes';

/**
 * Levels of a language: the CEFR levels and a native language. The model answers with the level, the quote holds it
 * as the resume writes it — by a spelling of `LANGUAGE_LEVEL_SPELLINGS`.
 */
export const LANGUAGE_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native'] as const;
type LanguageLevel = (typeof LANGUAGE_LEVELS)[number];

/**
 * How resumes write each level: the CEFR code, the names of the hh.ru scale («B2 — Средне-продвинутый») and of the
 * English course scale («Upper-Intermediate»). A name several levels share («Fluent», «Разговорный») states none of them.
 */
const LANGUAGE_LEVEL_SPELLINGS: Record<LanguageLevel, readonly string[]> = {
	A1: ['A1', 'Начальный', 'Beginner', 'Starter'],
	A2: ['A2', 'Элементарный', 'Elementary', 'Pre-Intermediate'],
	B1: ['B1', 'Средний', 'Intermediate'],
	B2: ['B2', 'Средне-продвинутый', 'Upper-Intermediate'],
	C1: ['C1', 'Продвинутый', 'Advanced'],
	C2: ['C2', 'В совершенстве', 'Proficiency', 'Proficient'],
	native: ['Родной', 'Native', 'Носитель', 'Mother tongue']
};

const isLanguageLevel = (level: string): level is LanguageLevel =>
	(LANGUAGE_LEVELS as readonly string[]).includes(level);

/** A hyphen joins the words of a level name: «Intermediate» is not in «Upper-Intermediate». */
const LEVEL_WORD_CHAR = /[\p{L}\p{N}-]/u;

/** Whether the text writes `spelling` as a whole name. */
function writesLevel(text: string, spelling: string): boolean {
	const haystack = fold(text);
	const needle = fold(spelling);
	for (let from = haystack.indexOf(needle); from >= 0; from = haystack.indexOf(needle, from + 1)) {
		const before = Array.from(haystack.slice(0, from)).at(-1);
		const after = Array.from(haystack.slice(from + needle.length)).at(0);
		if (!(before && LEVEL_WORD_CHAR.test(before)) && !(after && LEVEL_WORD_CHAR.test(after))) return true;
	}
	return false;
}

/**
 * The quote states the level: one of its spellings for a level of the list, the level itself as written otherwise (the
 * rules take the level from the text as it is).
 */
export function levelStated(level: string, quote: string): boolean {
	const spellings = isLanguageLevel(level) ? LANGUAGE_LEVEL_SPELLINGS[level] : [level];
	return spellings.some((spelling) => writesLevel(quote, spelling));
}

/** A level as written, read as a level of the list when it is one of its spellings («Upper-Intermediate» is B2). */
export function canonicalLevel(level: string): string {
	const written = fold(level);
	const found = LANGUAGE_LEVELS.find((key) => LANGUAGE_LEVEL_SPELLINGS[key].some((s) => fold(s) === written));
	return found ?? level;
}
