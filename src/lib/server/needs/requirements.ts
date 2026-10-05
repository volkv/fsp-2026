// Requirements a text of a need lists that the taxonomy does not know (docs/domain.md, section 13.10): «Требования:
// Python, Hugging Face, Docker» — Python and Docker are skills of the taxonomy, Hugging Face is a tool the employer asked
// for that no alias names. Such a requirement is kept by its name for the employer to confirm; it is never dropped and
// never replaced by a broader skill. Only items of a list of requirements count — the lead of the line says so — and an
// item the text negates («Kotlin не требуется», «без 1С») is not a requirement.
import type { Block } from '$lib/server/ml/quotes';

export interface ListedRequirement {
	name: string;
	requirement: 'required' | 'nice';
	/** The line the item stands in. */
	quote: string;
}

const NICE_LEAD = /(будет плюсом|плюсом будет|желательно|приветствуется|nice to have|preferred|как плюс)/iu;
const REQUIRED_LEAD =
	/(требования|требуется|нужн\p{L}*|обязательн\p{L}*|необходим\p{L}*|стек|опыт (?:работы )?с|знание|владение|requirements|must have|we use|используем)/iu;
const NEGATED = /(не требуется|не нужн\p{L}*|не обязательн\p{L}*|не важн\p{L}*|^без\s|not required|no need)/iu;
/** Words of a sentence rather than of a tool name. */
const PROSE =
	/^(и|или|с|со|на|в|для|по|от|до|опыт|опыта|знание|знания|понимание|умение|работа|работы|работать|год|лет|года)$/iu;
/** A name of a tool: Latin letters or a capital, as the text writes a product («Hugging Face», «1С», «Битрикс»). */
const NAMED = /[A-Za-z]|^\p{Lu}|^\d+\p{Lu}/u;

/** The part of a line after its lead: «Требования: a, b» → «a, b»; a line without a lead lists nothing. */
function listOf(line: string): { list: string; requirement: 'required' | 'nice' } | null {
	const nice = NICE_LEAD.exec(line);
	const required = REQUIRED_LEAD.exec(line);
	const lead = nice ?? required;
	if (!lead) return null;
	const after = line.slice(lead.index + lead[0].length).replace(/^[\s:—–-]+/u, '');
	return { list: after, requirement: nice ? 'nice' : 'required' };
}

const fold = (text: string) =>
	text
		.toLowerCase()
		.replace(/ё/gu, 'е')
		.replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
		.trim();

/**
 * Names of the lists of requirements that none of the recognized mentions covers. `recognized` — the mentions the
 * taxonomy read in the text, as written; an item that contains one of them, or is contained in one, is that skill.
 */
export function unrecognizedRequirements(blocks: readonly Block[], recognized: readonly string[]): ListedRequirement[] {
	const known = recognized.map(fold).filter((text) => text !== '');
	const found: ListedRequirement[] = [];
	const seen = new Set<string>();
	for (const block of blocks) {
		const listed = listOf(block.text);
		if (!listed) continue;
		for (const raw of listed.list.split(/[,;]|\s+(?:и|and|или|or)\s+|\s\/\s/u)) {
			if (NEGATED.test(raw.trim())) continue;
			// Words of the sentence around the name go: «опыт с ClickHouse» names ClickHouse.
			const words = raw
				.replace(/[.!?:()«»"]+/gu, ' ')
				.trim()
				.split(/\s+/u)
				.filter((word) => word !== '');
			while (words.length > 0 && PROSE.test(words[0] ?? '')) words.shift();
			const name = words.join(' ');
			const folded = fold(name);
			// A tool is named in one to three words, not a sentence; digits alone are a number of years.
			if (folded === '' || words.length > 3 || !NAMED.test(name) || /^\d+$/u.test(folded)) continue;
			const padded = ` ${folded} `;
			if (known.some((skill) => padded.includes(` ${skill} `) || ` ${skill} `.includes(padded))) continue;
			if (seen.has(folded)) continue;
			seen.add(folded);
			found.push({ name, requirement: listed.requirement, quote: block.text });
		}
	}
	return found;
}
