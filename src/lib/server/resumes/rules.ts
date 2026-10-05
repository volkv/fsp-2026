// The deterministic resume extractor — the product's path without a model (docs/contracts.md, section 3.5): skills by
// the aliases of the taxonomy version, periods, job titles and organizations by patterns, sections by their headings.
// It answers in the flat item shape the elements of `resume-extract/v3` are turned into, and its items pass the same
// checks as the model's: a quote found in its block, supporting the item, with the negation detector applied. The name
// at the top, the contacts of the header and of the contacts section, and the soft skills are read as well: they are
// suggestions for the candidate's own profile, not evidence.
import type { ResumeItemKind } from '$lib/server/ml/resume-extract';
import { parseFullName } from '$lib/server/profile/contacts';
import { softSkillsIn } from '$lib/server/profile/soft-skills';
import { matchSkill } from '$lib/server/taxonomy/normalize';
import { findMarker } from './markers';
import { PERIOD_PATTERN } from './periods';
import { TITLE_WORD } from '$lib/server/taxonomy/roles';
import { skillSpans } from '$lib/server/taxonomy/skill-spans';
import type { ResumeTaxonomy } from './taxonomy';

/** Version of this extractor (`ml_results.rules_version`): any change of what it finds is a new version. */
export const RULES_VERSION = 'resume-rules/4';

export interface RuleBlock {
	id: string;
	text: string;
	kind: 'heading' | 'paragraph' | 'list_item' | 'table_cell' | 'line';
	/** Column of a multi-column layout (`docparse` blocks); `null` — the full width of the page or a single column. */
	column: number | null;
}

/** An item in the flat shape of every resume extractor (`resumeCandidateSchema` of `resume-extract/v3`). */
export interface RuleItem {
	kind: ResumeItemKind;
	group?: string;
	raw_text: string;
	polarity: 'asserted';
	period_from?: string;
	period_to?: string;
	level?: string;
	block_id: string;
	quote: string;
}

type Section = 'unknown' | 'experience' | 'education' | 'skills' | 'languages' | 'about' | 'desired' | 'contacts';

const SECTION_HEADINGS: readonly [RegExp, Section][] = [
	[
		/^(опыт работы|опыт|трудовая деятельность|места работы|work experience|professional experience|experience|employment)/iu,
		'experience'
	],
	[/^(образование|курсы|повышение квалификации|сертификаты|education|courses|certifications?)/iu, 'education'],
	[/^(знание языков|иностранные языки|языки|languages)/iu, 'languages'],
	[
		/^(ключевые навыки|навыки|технологии|технический стек|стек|компетенции|hard skills|skills|technologies)/iu,
		'skills'
	],
	[/^(о себе|обо мне|дополнительная информация|about me|about|summary)/iu, 'about'],
	[/^(желаемая должность|цель|objective)/iu, 'desired'],
	[/^(контакты|contacts)/iu, 'contacts']
];

/** Longest heading line: a longer line is text that happens to start with a heading word. */
const MAX_HEADING = 60;

/** A heading written as a paragraph: the words alone, a trailing colon, or a count such as «— 7 лет 1 месяц». */
const HEADING_LINE = /^[\p{L}\s]+(?:\s*[—–-]\s*[\p{L}\s]*\d[\p{L}\p{N}\s]*|:)?$/u;

function sectionOf(block: RuleBlock): Section | null {
	const text = block.text.trim();
	if (text.includes('\n') || text.length > MAX_HEADING) return null;
	const found = SECTION_HEADINGS.find(([pattern]) => pattern.test(text));
	if (!found) return null;
	// A paragraph counts as a heading only when it is the heading word alone, possibly with a count («— 7 лет»).
	if (block.kind !== 'heading' && !HEADING_LINE.test(text)) return null;
	return found[1];
}

const ORGANIZATION =
	/((?<![\p{L}])(ООО|ОАО|ЗАО|ПАО|АО|ИП|НКО|ФГУП|ГУП|МУП|ГК|LLC|Inc|Ltd|GmbH|JSC)(?![\p{L}])|«[^»]{2,}»|"[^"]{2,}")/u;
/** A line of a list or a sentence is not a title. */
const LIST_LINE = /^[•·*▪◦‣—–-]/u;
const MAX_TITLE = 80;

const LANGUAGE_LEVEL =
	/(Английский|Немецкий|Французский|Испанский|Итальянский|Китайский|Японский|Корейский|English|German|French|Spanish|Italian|Chinese|Japanese)(?:\s+(?:язык|language))?\s*[—–:-]\s*(A1|A2|B1|B2|C1|C2|Upper[- ]Intermediate|Pre[- ]Intermediate|Intermediate|Advanced|Fluent|Elementary|Beginner|Proficient)/gu;

/**
 * A line of an education entry that states the degree or the form of study, not the institution: «Бакалавр, прикладная
 * информатика, 2023» under the university's name.
 */
const DEGREE_LINE =
	/^(бакалавр|магистр|специалист|аспирант|кандидат\s+\p{L}+\s+наук|доктор\s+\p{L}+\s+наук|высшее|неоконченное высшее|среднее|bachelor|master|specialist|ph\.?\s?d|b\.?\s?sc|m\.?\s?sc|mba)(?![\p{L}])/iu;

/** Lines at the top of a resume the name may stand on: a heading such as «Резюме» may come first. */
const NAME_LINES = 3;
const NOT_A_NAME = /^(резюме|cv|curriculum vitae|resume)$/iu;

/** A Russian phone in a common spelling, or an international one written with `+`. */
const PHONE =
	/(?<![\d+])(?:(?:\+7|8)[\s‐-]*\(?\d{3}\)?[\s‐-]*\d{3}[\s‐-]*\d{2}[\s‐-]*\d{2}|\+\d{1,3}[\s‐-]*\(?\d{2,4}\)?(?:[\s‐-]*\d{2,4}){2,4})(?!\d)/gu;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
/** A Telegram username: a `t.me` link, a name after the word «Telegram», or `@name` that is not part of an address. */
const TELEGRAM =
	/(?:(?:https?:\/\/)?(?:t\.me|telegram\.me)\/[A-Za-z][A-Za-z0-9_]{4,31}|(?<=(?:telegram|телеграм|tg)\s*[:—–-]?\s*)@?[A-Za-z][A-Za-z0-9_]{4,31}|(?<![\w.@])@[A-Za-z][A-Za-z0-9_]{4,31})(?![\w@.])/giu;

/** Sections whose contacts are the person's own: the header before any section, and the contacts section. */
const CONTACT_SECTIONS: ReadonlySet<Section> = new Set(['unknown', 'contacts']);
/** Sections that name no soft skill of the person: the list of schools, of languages. */
const NO_SOFT_SKILLS: ReadonlySet<Section> = new Set(['education', 'languages']);

interface Job {
	label: string;
	/** Columns the job's lines are in: a heading in one of them ends the job. */
	columns: Set<number | null>;
	hasPeriod: boolean;
	hasTitle: boolean;
	hasOrganization: boolean;
	/** Lines of the job's description have begun: a heading line after them starts the next job. */
	hasBody: boolean;
}

type HeaderField = 'hasPeriod' | 'hasTitle' | 'hasOrganization';

/** A dot that ends an abbreviation, not a sentence: an initial («ИП Выдумкин Н. Н.») or a company form («Acme Inc.»). */
const ABBREVIATION_END = /(?:^|[\s,.])(?:\p{Lu}|Inc|Ltd|Co|Corp)\.$/u;

/** A line of a job's description: a list item, a sentence or a line too long for a title. */
function isBodyLine(line: string, block: RuleBlock): boolean {
	const sentence = line.endsWith('.') && !ABBREVIATION_END.test(line);
	return block.kind === 'list_item' || LIST_LINE.test(line) || sentence || line.length > MAX_TITLE;
}

/**
 * Items of a resume by rules. A job is a run of heading lines — its period, organization and title, in any order —
 * followed by its description: resumes put the title before the period as often as after it. In the experience section
 * any such run is a job, dated or not; in a resume without headings only a period opens one, so that the desired
 * position above the experience is not taken for a job.
 */
export function extractByRules(blocks: readonly RuleBlock[], taxonomy: ResumeTaxonomy): RuleItem[] {
	const items: RuleItem[] = [];
	const seen = new Set<string>();
	const add = (item: RuleItem) => {
		const key = `${item.block_id}\u0000${item.kind}\u0000${item.group ?? ''}\u0000${item.quote}`;
		if (seen.has(key)) return;
		seen.add(key);
		items.push(item);
	};
	// Sections by column. A heading across the page starts a section for every column; a heading inside a column (a
	// sidebar with skills and languages beside the experience) starts it for that column only. A block of a column
	// without its own heading, or across the page, continues the section of the block read before it: the dates beside
	// the jobs of a two-column experience section, the jobs that go on under a sidebar that has ended.
	let reading: Section = 'unknown';
	const columnSections = new Map<number, Section>();
	const sectionOfBlock = (block: RuleBlock): Section =>
		block.column === null ? reading : (columnSections.get(block.column) ?? reading);
	// The current job lives in an object: `jobFor` replaces it, which narrowing of a local variable would not see.
	const current: { job: Job | null } = { job: null };
	let jobs = 0;
	let nameLinesLeft = NAME_LINES;
	let nameFound = false;
	const softSkillsFound = new Set<string>();

	/** The job a heading line belongs to: the current one while its heading lasts and lacks this field, else a new one. */
	const jobFor = (field: HeaderField, blockSection: Section): Job | null => {
		const { job } = current;
		if (job && !job.hasBody && !job[field]) return job;
		if (blockSection !== 'experience' && field !== 'hasPeriod') return null;
		current.job = {
			label: `job-${++jobs}`,
			columns: new Set(),
			hasPeriod: false,
			hasTitle: false,
			hasOrganization: false,
			hasBody: false
		};
		return current.job;
	};

	for (const block of blocks) {
		const heading = sectionOf(block);
		if (heading) {
			if (block.column === null) columnSections.clear();
			else columnSections.set(block.column, heading);
			reading = heading;
			const { job } = current;
			if (job && (block.column === null || job.columns.has(block.column) || job.columns.has(null))) current.job = null;
			continue;
		}
		const blockSection = sectionOfBlock(block);
		reading = blockSection;
		const inWork = blockSection === 'experience' || blockSection === 'unknown';

		// The name: one of the first lines of the resume, before any section, that reads as two or three name words.
		if (!nameFound && blockSection === 'unknown' && jobs === 0) {
			for (const rawLine of block.text.split('\n')) {
				const line = rawLine.trim();
				if (line.length === 0 || nameLinesLeft === 0) continue;
				nameLinesLeft--;
				if (NOT_A_NAME.test(line) || TITLE_WORD.test(line) || ORGANIZATION.test(line)) continue;
				if (parseFullName(line) === null) continue;
				nameFound = true;
				add({ kind: 'full_name', raw_text: line, polarity: 'asserted', block_id: block.id, quote: line });
				break;
			}
		}
		if (CONTACT_SECTIONS.has(blockSection) && jobs === 0) {
			for (const [pattern, kind] of [
				[PHONE, 'contact_phone'],
				[EMAIL, 'contact_email'],
				[TELEGRAM, 'contact_telegram']
			] as const) {
				for (const match of block.text.matchAll(pattern)) {
					const [found] = match;
					add({ kind, raw_text: found, polarity: 'asserted', block_id: block.id, quote: found });
				}
			}
		}
		if (!NO_SOFT_SKILLS.has(blockSection)) {
			for (const { skill, written } of softSkillsIn(block.text)) {
				if (softSkillsFound.has(skill.key)) continue;
				softSkillsFound.add(skill.key);
				add({ kind: 'soft_skill', raw_text: written, polarity: 'asserted', block_id: block.id, quote: written });
			}
		}

		// A period may wrap onto the next line («Март 2021 —\nнастоящее время»): it is found in the block and belongs to
		// the line it starts on; the lines it covers are not titles.
		const periods = inWork
			? Array.from(block.text.matchAll(PERIOD_PATTERN)).flatMap((match) => {
					const [whole, from, to] = match;
					return from && to ? [{ whole, from, to, start: match.index, end: match.index + whole.length }] : [];
				})
			: [];

		// A list item is one entry: a line break inside it is a wrap, not a separator.
		const skills = skillSpans(block.text, taxonomy.spans, block.kind === 'list_item');

		let lineStart = 0;
		for (const rawLine of block.text.split('\n')) {
			const lineEnd = lineStart + rawLine.length;
			const line = rawLine.trim();
			const lineOffset = lineStart;
			lineStart = lineEnd + 1;
			if (line.length === 0) continue;

			if (inWork) {
				const startingHere = periods.filter((period) => period.start >= lineOffset && period.start <= lineEnd);
				const inPeriod = periods.some((period) => period.start <= lineEnd && period.end >= lineOffset);
				for (const period of startingHere) {
					const target = jobFor('hasPeriod', blockSection);
					if (!target) continue;
					target.hasPeriod = true;
					target.columns.add(block.column);
					add({
						kind: 'experience_period',
						group: target.label,
						raw_text: period.whole,
						polarity: 'asserted',
						period_from: period.from,
						period_to: period.to,
						block_id: block.id,
						quote: period.whole
					});
				}
				if (!inPeriod) {
					if (isBodyLine(line, block)) {
						if (current.job) {
							current.job.hasBody = true;
							current.job.columns.add(block.column);
						}
					} else if (ORGANIZATION.test(line)) {
						const target = jobFor('hasOrganization', blockSection);
						if (target) {
							target.hasOrganization = true;
							target.columns.add(block.column);
							add({
								kind: 'organization',
								group: target.label,
								raw_text: line,
								polarity: 'asserted',
								block_id: block.id,
								quote: line
							});
						}
					} else if (TITLE_WORD.test(line)) {
						const target = jobFor('hasTitle', blockSection);
						if (target) {
							target.hasTitle = true;
							target.columns.add(block.column);
							add({
								kind: 'role_title',
								group: target.label,
								raw_text: line,
								polarity: 'asserted',
								block_id: block.id,
								quote: line
							});
						}
					}
				}
			}
			const grouped = inWork && current.job !== null ? { group: current.job.label } : {};

			const marker = findMarker(line);
			if (marker) {
				add({
					kind: 'responsibility_marker',
					...grouped,
					raw_text: marker.phrase,
					polarity: 'asserted',
					block_id: block.id,
					quote: marker.phrase
				});
			}
			for (const skill of skills) {
				if (skill.start < lineOffset || skill.start > lineEnd) continue;
				add({
					kind: 'skill_mention',
					...grouped,
					raw_text: skill.text,
					polarity: 'asserted',
					block_id: block.id,
					quote: skill.text
				});
			}
		}

		if (blockSection === 'education') {
			const [first] = block.text.trim().split('\n');
			const line = first?.trim() ?? '';
			if (/\p{L}{3,}/u.test(line) && !DEGREE_LINE.test(line)) {
				add({ kind: 'education', raw_text: line, polarity: 'asserted', block_id: block.id, quote: line });
			}
		}

		for (const match of block.text.matchAll(LANGUAGE_LEVEL)) {
			const [whole, language, level] = match;
			if (!language || !level) continue;
			add({
				kind: 'language_level',
				raw_text: language,
				level,
				polarity: 'asserted',
				block_id: block.id,
				quote: whole
			});
			// A language the taxonomy has as a skill, stated with its level, is that skill («Английский — B2» — `english`);
			// a name the scanner has taken already («English — B2») is not a second mention.
			const named = matchSkill(taxonomy.skills, language);
			if (named.method === 'alias' && !skills.some((span) => span.start === match.index)) {
				add({ kind: 'skill_mention', raw_text: language, polarity: 'asserted', block_id: block.id, quote: whole });
			}
		}
	}
	return items;
}
