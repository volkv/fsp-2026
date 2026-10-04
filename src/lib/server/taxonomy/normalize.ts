// Skill normalization (docs/domain.md sections 9.2, 11): exact alias → fuzzy match with a threshold → unknown.
// Two canonical skills that are equally close to the text are a refusal, not a guess.

/** Fuzzy matching is not attempted below this length: short names (`c`, `r`, `go`, `c#`) differ by one character. */
const FUZZY_MIN_LENGTH = 5;
/** Minimum similarity `1 − distance / longer length`: one edit in five characters, two in ten. */
const FUZZY_THRESHOLD = 0.8;
/** Skills whose similarity is within this margin of the best one are indistinguishable. */
const AMBIGUITY_MARGIN = 0.05;

const EDGE_PUNCTUATION = `\\s"'«»“”„()\\[\\]{},;:!?`;
const LEADING_NOISE = new RegExp(`^[${EDGE_PUNCTUATION}]+`, 'u');
// A trailing dot is sentence punctuation; a leading one belongs to the name (`.net`).
const TRAILING_NOISE = new RegExp(`[${EDGE_PUNCTUATION}.]+$`, 'u');

/**
 * Canonical form of a skill mention: case, `ё`, dashes and spacing are folded, while significant punctuation stays,
 * so `C`, `C++` and `C#` or `.NET` and `NET` remain different strings.
 */
export function normalizeSkillText(raw: string): string {
	return raw
		.normalize('NFKC')
		.toLowerCase()
		.replaceAll('ё', 'е')
		.replace(/[‐-―−]/gu, '-')
		.replace(/[_-]/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim()
		.replace(LEADING_NOISE, '')
		.replace(TRAILING_NOISE, '');
}

export interface SkillAlias {
	aliasNormalized: string;
	skillKey: string;
}

interface FuzzyEntry {
	skillKey: string;
	characters: readonly string[];
}

export interface SkillIndex {
	readonly exact: ReadonlyMap<string, string>;
	readonly fuzzy: readonly FuzzyEntry[];
}

const graphemes = new Intl.Segmenter('ru', { granularity: 'grapheme' });

/** User-perceived characters: an edit is one character, whatever its UTF-16 length. */
function charactersOf(text: string): string[] {
	return Array.from(graphemes.segment(text), (part) => part.segment);
}

interface SkillCandidate {
	skillKey: string;
	score: number;
}

/** Result of normalizing one mention; fields match `claims.normalization` plus the resolved key. */
export type SkillMatch =
	| { method: 'alias'; skillKey: string; score: 1; normalized: string; alternatives: [] }
	| { method: 'fuzzy'; skillKey: string; score: number; normalized: string; alternatives: [] }
	| { method: 'unknown'; skillKey: null; score: number | null; normalized: string; alternatives: SkillCandidate[] };

/** Builds the lookup structure of one taxonomy version; an alias pointing to two skills is a data error. */
export function buildSkillIndex(aliases: readonly SkillAlias[]): SkillIndex {
	const exact = new Map<string, string>();
	for (const { aliasNormalized, skillKey } of aliases) {
		if (aliasNormalized !== normalizeSkillText(aliasNormalized)) {
			throw new Error(`alias "${aliasNormalized}" is not in normalized form`);
		}
		const owner = exact.get(aliasNormalized);
		if (owner !== undefined && owner !== skillKey) {
			throw new Error(`alias "${aliasNormalized}" belongs to both ${owner} and ${skillKey}`);
		}
		exact.set(aliasNormalized, skillKey);
	}
	const fuzzy = [...exact]
		.map(([alias, skillKey]) => ({ skillKey, characters: charactersOf(alias) }))
		.filter((entry) => entry.characters.length >= FUZZY_MIN_LENGTH);
	return { exact, fuzzy };
}

/** Normalizes a skill mention against an index. Pure: the same index and text give the same result. */
export function matchSkill(index: SkillIndex, raw: string): SkillMatch {
	const normalized = normalizeSkillText(raw);
	const exact = index.exact.get(normalized);
	if (exact !== undefined) {
		return { method: 'alias', skillKey: exact, score: 1, normalized, alternatives: [] };
	}
	const characters = charactersOf(normalized);
	if (characters.length < FUZZY_MIN_LENGTH) {
		return { method: 'unknown', skillKey: null, score: null, normalized, alternatives: [] };
	}

	const bestBySkill = new Map<string, number>();
	for (const entry of index.fuzzy) {
		const longer = Math.max(characters.length, entry.characters.length);
		const maxDistance = Math.floor(longer * (1 - FUZZY_THRESHOLD) + 1e-9);
		if (Math.abs(characters.length - entry.characters.length) > maxDistance) continue;
		const distance = editDistance(characters, entry.characters, maxDistance);
		if (distance > maxDistance) continue;
		const score = 1 - distance / longer;
		if (score > (bestBySkill.get(entry.skillKey) ?? 0)) bestBySkill.set(entry.skillKey, score);
	}
	const ranked = [...bestBySkill]
		.map(([skillKey, score]) => ({ skillKey, score: round(score) }))
		.filter((candidate) => candidate.score >= FUZZY_THRESHOLD)
		.sort((a, b) => b.score - a.score || a.skillKey.localeCompare(b.skillKey));

	const [best] = ranked;
	if (!best) {
		return { method: 'unknown', skillKey: null, score: null, normalized, alternatives: [] };
	}
	const rivals = ranked.filter((candidate) => best.score - candidate.score <= AMBIGUITY_MARGIN);
	if (rivals.length > 1) {
		return { method: 'unknown', skillKey: null, score: best.score, normalized, alternatives: rivals };
	}
	return { method: 'fuzzy', skillKey: best.skillKey, score: best.score, normalized, alternatives: [] };
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/**
 * Optimal string alignment distance (Levenshtein with adjacent transpositions) between character sequences.
 * Returns `limit + 1` as soon as the distance is known to exceed `limit`.
 */
function editDistance(s: readonly string[], t: readonly string[], limit: number): number {
	let beforePrevious = new Array<number>(t.length + 1).fill(0);
	let previous = Array.from({ length: t.length + 1 }, (_, j) => j);
	for (let i = 1; i <= s.length; i++) {
		const current = new Array<number>(t.length + 1).fill(0);
		current[0] = i;
		let rowMin = i;
		for (let j = 1; j <= t.length; j++) {
			const cost = s[i - 1] === t[j - 1] ? 0 : 1;
			let value = Math.min(at(previous, j) + 1, at(current, j - 1) + 1, at(previous, j - 1) + cost);
			if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
				value = Math.min(value, at(beforePrevious, j - 2) + 1);
			}
			current[j] = value;
			rowMin = Math.min(rowMin, value);
		}
		if (rowMin > limit) return limit + 1;
		beforePrevious = previous;
		previous = current;
	}
	return at(previous, t.length);
}

function at(row: readonly number[], index: number): number {
	const value = row[index];
	if (value === undefined) throw new Error(`edit distance index ${index} out of range`);
	return value;
}
