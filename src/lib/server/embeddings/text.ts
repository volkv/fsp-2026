// Texts the embedder receives (docs/domain.md, sections 14, 16.3): the three sections of a candidate profile and the
// cut every input goes through. A candidate text holds only what the catalog card shows — skills, groups of experience
// by role and years, desired roles, FSP results in their generalized form — never names, organizations, position titles
// as written, the headline or resume text: a vector finds a candidate by what the employer may see. A change of what
// goes into a text is a new `chunkingVersion` of the space (definitions.ts).
import { AWARDS, COMPETITION_LEVELS, DISCIPLINES } from '$lib/components/product/model';
import { awardRank } from '$lib/fsp/awards';

/**
 * Characters of one input. The runtime accepts 512 tokens per input (definitions.ts) and refuses a longer one as a
 * server error. With the bge-m3 tokenizer a list of skill names takes about 2.5 characters per token and Russian prose
 * about 3.8; a list of short technical names (`C#, F#, R, 1С, Qt`) takes 1.7, so 800 characters stay under 512 tokens
 * even for that.
 */
export const MAX_INPUT_CHARS = 800;

/**
 * The text cut to `MAX_INPUT_CHARS` at the last whitespace before the limit; a text without whitespace there is cut at
 * the limit.
 */
export function fitText(text: string, maxChars: number = MAX_INPUT_CHARS): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	const head = trimmed.slice(0, maxChars + 1);
	const cut = head.search(/\s\S*$/);
	return (cut > 0 ? head.slice(0, cut) : head.slice(0, maxChars)).trimEnd();
}

/** Items joined by `separator` while the whole stays within the limit; the first item alone is cut to fit. */
function joinWithin(label: string, items: readonly string[], separator: string, maxChars: number): string | null {
	if (items.length === 0) return null;
	let text = label;
	for (const [index, item] of items.entries()) {
		const next = index === 0 ? text + item : text + separator + item;
		if (next.length > maxChars) return index === 0 ? fitText(next, maxChars) : text;
		text = next;
	}
	return text;
}

export type ProfileSection = 'skills' | 'experience' | 'summary';

export interface ExperienceGroup {
	/** Name of the role, `null` when the entry has none. */
	role: string | null;
	/** Years of a valid period: first and last (`null` — current). */
	years: { from: number; to: number | null } | null;
	/** Names of the applied skills. */
	skills: readonly string[];
}

export interface CompetitionResult {
	discipline: string;
	level: string;
	award: string;
	online: boolean | null;
}

/** What a profile text is built from, names already resolved. */
export interface ProfileFacts {
	/** Names of asserted skills, one per mention: claims and experience entries that apply the skill. */
	skills: readonly string[];
	experience: readonly ExperienceGroup[];
	desiredRoles: readonly string[];
	competitions: readonly CompetitionResult[];
	/** 18+ by the birth date: the catalog shows minors' results without the result group and format (domain 14). */
	adult: boolean;
}

export interface SectionText {
	section: ProfileSection;
	text: string;
}

const uniqueSorted = (values: readonly string[]) =>
	[...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))].sort((a, b) =>
		a.localeCompare(b, 'ru')
	);

/** Distinct names, the most mentioned first: what does not fit the text is the least supported. */
function byMentions(values: readonly string[]): string[] {
	const counts = new Map<string, number>();
	for (const value of values.map((v) => v.trim()).filter((v) => v !== '')) {
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru')).map(([value]) => value);
}

function experienceLine(group: ExperienceGroup): string | null {
	const skills = uniqueSorted(group.skills);
	if (group.role === null && skills.length === 0) return null;
	const years =
		group.years === null
			? null
			: group.years.to === null
				? `с ${group.years.from} по настоящее время`
				: group.years.from === group.years.to
					? String(group.years.from)
					: `${group.years.from}–${group.years.to}`;
	const head = [group.role, years].filter((part): part is string => part !== null).join(', ');
	const tail = skills.length > 0 ? `навыки: ${skills.join(', ')}` : null;
	return [head === '' ? null : head, tail].filter((part): part is string => part !== null).join('; ');
}

const DISCIPLINE_NAMES = Object.fromEntries(Object.entries(DISCIPLINES).map(([code, d]) => [code, d.name]));
const LEVEL_ORDER = Object.keys(COMPETITION_LEVELS);
const rank = (order: readonly string[], value: string) => {
	const index = order.indexOf(value);
	return index === -1 ? order.length : index;
};
const label = (labels: Readonly<Partial<Record<string, string>>>, value: string) => labels[value] ?? value;

function competitionLines(results: readonly CompetitionResult[], adult: boolean): string[] {
	const sorted = [...results].sort(
		(a, b) =>
			(adult ? awardRank(a.award) - awardRank(b.award) : 0) ||
			rank(LEVEL_ORDER, a.level) - rank(LEVEL_ORDER, b.level) ||
			a.discipline.localeCompare(b.discipline)
	);
	const lines = sorted.map((result) => {
		const discipline = label(DISCIPLINE_NAMES, result.discipline);
		const parts = [label(COMPETITION_LEVELS, result.level)];
		if (adult) {
			parts.push(label(AWARDS, result.award).toLowerCase());
			if (result.online !== null) parts.push(result.online ? 'онлайн' : 'очно');
		}
		return `${discipline} — ${parts.join(', ')}`;
	});
	return [...new Set(lines)];
}

/**
 * The sections of a profile that have content, in a fixed order. Every text fits `MAX_INPUT_CHARS`; lists are ordered
 * deterministically so that the same facts give the same text and the same `input_sha256`.
 */
export function profileSections(facts: ProfileFacts): SectionText[] {
	const sections: SectionText[] = [];
	const skills = joinWithin('Навыки: ', byMentions(facts.skills), ', ', MAX_INPUT_CHARS);
	if (skills !== null) sections.push({ section: 'skills', text: skills });

	// The latest experience first: what does not fit is the oldest.
	const recent = (group: ExperienceGroup) => (group.years === null ? -1 : (group.years.to ?? Infinity));
	const lines = [
		...new Set(
			[...facts.experience]
				.map((group) => ({ group, line: experienceLine(group) }))
				.filter((entry): entry is { group: ExperienceGroup; line: string } => entry.line !== null)
				.sort(
					(a, b) =>
						recent(b.group) - recent(a.group) ||
						(b.group.years?.from ?? -1) - (a.group.years?.from ?? -1) ||
						a.line.localeCompare(b.line, 'ru')
				)
				.map((entry) => entry.line)
		)
	];
	const experience = joinWithin('Опыт работы: ', lines, '\n', MAX_INPUT_CHARS);
	if (experience !== null) sections.push({ section: 'experience', text: experience });

	// At most three desired roles (candidates_desired_roles): the line always fits, the results take the rest.
	const desired = joinWithin('Желаемые роли: ', uniqueSorted(facts.desiredRoles), ', ', MAX_INPUT_CHARS);
	const room = MAX_INPUT_CHARS - (desired === null ? 0 : desired.length + 1);
	const competitions = joinWithin('Соревнования ФСП: ', competitionLines(facts.competitions, facts.adult), '; ', room);
	const summary = [desired, competitions].filter((part): part is string => part !== null).join('\n');
	if (summary !== '') sections.push({ section: 'summary', text: summary });
	return sections;
}
