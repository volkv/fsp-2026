// `resume-extract/v2`: facts of a resume, each with a quote (docs/contracts.md, section 3.2; docs/domain.md, 9.2, 9.5).
//
// The answer has one array per kind of fact, the jobs nested with their own arrays, and every key of an element is
// required: structured output of the runtime accepts neither nullable types nor optional keys the model reliably fills,
// so a value the text does not state is written explicitly — `not_stated`. The elements of the answer become the flat
// items every extractor of the product answers in (the deterministic rules too, `resumes/rules.ts`), and every item
// passes the same checks: the quote is in its block, the quote states the value.
import { z } from 'zod';
import { isPresent, parseDate } from '$lib/server/resumes/periods';
import { findMarker } from '$lib/server/resumes/markers';
import {
	NOT_STATED,
	flatJsonSchema,
	itemSchemaFailure,
	locateItemQuote,
	type ItemQuote,
	type CheckedItems,
	type PreparedExtract,
	type Rejected
} from './extract-common';
import { LANGUAGE_LEVELS, canonicalLevel, levelStated } from './language-levels';
import { RESUME_SYSTEM_PROMPT } from './prompts';
import {
	POLARITIES,
	containsTerm,
	detectPolarity,
	fold,
	locateQuote,
	quoteNamesSkill,
	type Block,
	type Polarity,
	type QuoteLocation,
	type SkillLexicon
} from './quotes';

export const RESUME_ITEM_KINDS = [
	'skill_mention',
	'experience_period',
	'role_title',
	'organization',
	'education',
	'responsibility_marker',
	'language_level',
	'achievement_mention'
] as const;

export type ResumeItemKind = (typeof RESUME_ITEM_KINDS)[number];

/**
 * One fact before its checks, in the shape every extractor answers in: the elements of the model's answer are turned
 * into it, the rules produce it directly. `group` ties the facts of one job together.
 */
export const resumeCandidateSchema = z.strictObject({
	kind: z.enum(RESUME_ITEM_KINDS),
	group: z.string().optional(),
	raw_text: z.string(),
	polarity: z.enum(POLARITIES),
	period_from: z.string().optional(),
	period_to: z.string().optional(),
	organization: z.string().optional(),
	level: z.string().optional(),
	block_id: z.string(),
	quote: z.string()
});

type ResumeCandidate = z.infer<typeof resumeCandidateSchema>;

const located = { block_id: z.string(), quote: z.string() };
const textElement = z.strictObject({ raw_text: z.string(), ...located });
const skillElement = z.strictObject({ raw_text: z.string(), polarity: z.enum(POLARITIES), ...located });
const periodElement = z.strictObject({ date_from: z.string(), date_to: z.string(), ...located });
const educationElement = z.strictObject({ institution: z.string(), ...located });
/**
 * The level comes after the quote: the model writes the level it has just copied. Before the quote it wrote a wrong
 * level of the list on six documents of the evaluation set («C2» for «Английский — C1»).
 */
const languageElement = z.strictObject({
	language: z.string(),
	...located,
	level: z.enum([...LANGUAGE_LEVELS, NOT_STATED])
});

/** Arrays of one job: the element schema and what an element stands for. */
const JOB_ARRAYS = {
	role_titles: { kind: 'role_title', schema: textElement },
	organizations: { kind: 'organization', schema: textElement },
	periods: { kind: 'experience_period', schema: periodElement },
	skills: { kind: 'skill_mention', schema: skillElement },
	responsibilities: { kind: 'responsibility_marker', schema: textElement }
} as const satisfies Record<string, { kind: ResumeItemKind; schema: z.ZodObject }>;

/** Arrays of facts not tied to a job. */
const RESUME_ARRAYS = {
	skills: { kind: 'skill_mention', schema: skillElement },
	responsibilities: { kind: 'responsibility_marker', schema: textElement },
	education: { kind: 'education', schema: educationElement },
	languages: { kind: 'language_level', schema: languageElement },
	achievements: { kind: 'achievement_mention', schema: textElement }
} as const satisfies Record<string, { kind: ResumeItemKind; schema: z.ZodObject }>;

type JobKey = keyof typeof JOB_ARRAYS;
type ResumeKey = keyof typeof RESUME_ARRAYS;
const JOB_KEYS = Object.keys(JOB_ARRAYS) as JobKey[];
const RESUME_KEYS = Object.keys(RESUME_ARRAYS) as ResumeKey[];

/**
 * Upper bounds of the arrays. A greedy small model repeats itself — the array of jobs it pads with empty and repeated
 * jobs up to the bound — so the bound is what the answer may spend on a loop, not what a resume holds. Ten jobs: a job
 * with its skills takes 300–600 tokens of the output limit (8 192), a longer career does not fit it anyway. 25 skills of
 * one job: its own lines name far fewer; more is the skills section copied into the job, which the product refuses as
 * not the job's.
 */
const MAX = { jobs: 10, heading: 2, jobSkills: 25, skills: 80, responsibilities: 10, entries: 10, achievements: 20 };

const jobSchema = z.strictObject({
	role_titles: z.array(textElement).max(MAX.heading),
	organizations: z.array(textElement).max(MAX.heading),
	periods: z.array(periodElement).max(MAX.heading),
	skills: z.array(skillElement).max(MAX.jobSkills),
	responsibilities: z.array(textElement).max(MAX.responsibilities)
});

/**
 * The answer: the number of jobs, then the jobs in the order of the resume, then the facts of the rest of it. The model
 * counts the places of work before it writes them: it counts them right and pads the array less (fewer tokens); the
 * product reads the jobs, not the count.
 */
const resumeAnswerSchema = z.strictObject({
	job_count: z.int().min(0).max(MAX.jobs),
	jobs: z.array(jobSchema).max(MAX.jobs),
	skills: z.array(skillElement).max(MAX.skills),
	responsibilities: z.array(textElement).max(MAX.responsibilities),
	education: z.array(educationElement).max(MAX.entries),
	languages: z.array(languageElement).max(MAX.entries),
	achievements: z.array(textElement).max(MAX.achievements)
});

export const RESUME_EXTRACT_JSON_SCHEMA = flatJsonSchema(resumeAnswerSchema);

const unknownArrays = <K extends string>(keys: readonly K[]) =>
	z.object(Object.fromEntries(keys.map((key) => [key, z.array(z.unknown())])) as Record<K, z.ZodArray<z.ZodUnknown>>);

const jobEnvelopeSchema = unknownArrays(JOB_KEYS);
const resumeEnvelopeSchema = unknownArrays(RESUME_KEYS).extend({ jobs: z.array(z.unknown()) });

export interface ResumeItem {
	kind: ResumeItemKind;
	group: string | null;
	rawText: string;
	/** Final polarity: the model's, moved towards `negated`/`uncertain` by the negation detector. */
	polarity: Polarity;
	modelPolarity: Polarity;
	periodFrom: string | null;
	periodTo: string | null;
	organization: string | null;
	level: string | null;
	quote: QuoteLocation;
}

const YEAR = /(?<!\d)(?:19|20)\d{2}(?!\d)/gu;

function yearsOf(text: string): string[] {
	return Array.from(text.matchAll(YEAR), (match) => match[0]);
}

/**
 * The quote states the period and both of its ends are dates the product reads (`resumes/periods.ts`): the start is a
 * date, the end a date or «по настоящее время», each written in the quote, and every year of them is in the quote.
 */
function periodSupported(item: ResumeCandidate, quote: string): boolean {
	const from = item.period_from?.trim() ?? '';
	const to = item.period_to?.trim() ?? '';
	if (parseDate(from, false) === null) return false;
	if (!isPresent(to) && parseDate(to, true) === null) return false;
	const text = fold(quote);
	if (!text.includes(fold(from)) || !text.includes(fold(to))) return false;
	const inQuote = new Set(yearsOf(quote));
	return [...yearsOf(from), ...yearsOf(to)].every((year) => inQuote.has(year));
}

/** The quote supports the item: a skill by an alias, a period by its dates, other kinds by their raw text. */
function quoteSupports(item: ResumeCandidate, quote: string, lexicon: SkillLexicon): boolean {
	const text = fold(quote);
	switch (item.kind) {
		case 'skill_mention':
			return quoteNamesSkill(quote, item.raw_text, lexicon);
		case 'experience_period':
			return periodSupported(item, quote);
		case 'language_level':
			return text.includes(fold(item.raw_text)) && (item.level === undefined || levelStated(item.level, quote));
		case 'responsibility_marker':
			// A responsibility is a marker the product recognises (mentoring, leading a team, architecture) or nothing.
			return text.includes(fold(item.raw_text)) && findMarker(quote) !== null;
		default:
			return text.includes(fold(item.raw_text));
	}
}

/**
 * The block of the candidate and the place of its quote. A skill whose quote is not in the block it names — the model
 * often gives a skill of a job the block of the job's title — is found in the block that holds the quote as whole words,
 * when exactly one other block does («Go» is not in «Golang»); a quote several blocks hold cannot be told apart, and is
 * refused as not found.
 */
function locateCandidateQuote(candidate: ResumeCandidate, byId: ReadonlyMap<string, Block>): ItemQuote {
	const found = locateItemQuote(byId, candidate.block_id, candidate.quote);
	if (found.ok || candidate.kind !== 'skill_mention' || found.reason === 'quote_is_instruction') return found;
	const holders = [...byId.values()].filter(
		(block) =>
			block.id !== candidate.block_id &&
			containsTerm(block.text, candidate.quote) &&
			locateQuote(block, candidate.quote) !== null
	);
	const [holder] = holders;
	return holders.length === 1 && holder ? locateItemQuote(byId, holder.id, candidate.quote) : found;
}

/** One candidate through the checks: the item it becomes, or the reason it is refused. */
function checkCandidate(
	candidate: ResumeCandidate,
	byId: ReadonlyMap<string, Block>,
	lexicon: SkillLexicon
): { ok: true; item: ResumeItem } | { ok: false; reason: Rejected['reason'] } {
	const found = locateCandidateQuote(candidate, byId);
	if (!found.ok) return { ok: false, reason: found.reason };
	if (!quoteSupports(candidate, found.location.text, lexicon)) return { ok: false, reason: 'quote_not_supporting' };
	return {
		ok: true,
		item: {
			kind: candidate.kind,
			group: candidate.group?.trim() ? candidate.group.trim() : null,
			rawText: candidate.raw_text,
			polarity: detectPolarity(candidate.polarity, found.block.text, found.location),
			modelPolarity: candidate.polarity,
			periodFrom: candidate.period_from ?? null,
			periodTo: candidate.period_to ?? null,
			organization: candidate.organization ?? null,
			level: candidate.level === undefined ? null : canonicalLevel(candidate.level),
			quote: found.location
		}
	};
}

/** A group is one job: without a role title or a period it cannot become an experience entry (domain 9.5). */
function dropIncompleteGroups(accepted: readonly ResumeItem[], rejected: Rejected[]): ResumeItem[] {
	const anchored = new Set(
		accepted
			.filter((item) => item.group !== null && (item.kind === 'role_title' || item.kind === 'experience_period'))
			.map((item) => item.group)
	);
	return accepted.filter((item) => {
		const kept = item.group === null || anchored.has(item.group);
		if (!kept) rejected.push({ item, reason: 'incomplete_group' });
		return kept;
	});
}

/** Candidates in the flat shape — the rules' answer — through the checks. */
export function checkResumeItems(
	rawItems: readonly unknown[],
	blocks: readonly Block[],
	lexicon: SkillLexicon
): CheckedItems<ResumeItem> {
	const byId = new Map(blocks.map((block) => [block.id, block]));
	const accepted: ResumeItem[] = [];
	const rejected: Rejected[] = [];
	for (const raw of rawItems) {
		const schemaFailure = itemSchemaFailure(resumeCandidateSchema, ['kind', 'polarity'], raw);
		if (schemaFailure) {
			rejected.push(schemaFailure);
			continue;
		}
		const candidate = raw as ResumeCandidate;
		const checked = checkCandidate(candidate, byId, lexicon);
		if (checked.ok) accepted.push(checked.item);
		else rejected.push({ item: candidate, reason: checked.reason });
	}
	return { items: dropIncompleteGroups(accepted, rejected), rejected };
}

const stated = (value: string): string | undefined => (value.trim() === NOT_STATED ? undefined : value);

/** «Английский язык» is the language «Английский»: the name without the word for language, as the rules read it. */
function languageName(written: string): string {
	return written.trim().replace(/\s+(?:язык|language)$/iu, '');
}

/**
 * The line of a quote that names the value. A list of languages is one block, and a quote of several of its lines
 * («Русский — родной\nАнглийский — B1») would tie each language to the others' levels, and a foreign language to the
 * native one; the quote of the language is its own line. A quote without such a line stays as it is and is checked
 * as it is.
 */
function lineNaming(quote: string, value: string): string {
	const lines = quote.split('\n');
	if (lines.length === 1) return quote;
	return lines.find((line) => fold(line).includes(fold(value))) ?? quote;
}

/** The flat candidates an element of the answer stands for. */
function candidatesOf(
	kind: ResumeItemKind,
	element: Record<string, unknown>,
	group: string | undefined,
	lexicon: SkillLexicon
): ResumeCandidate[] {
	const base = {
		kind,
		...(group === undefined ? {} : { group }),
		polarity: 'asserted' as Polarity,
		block_id: element.block_id as string,
		quote: element.quote as string
	};
	switch (kind) {
		case 'skill_mention': {
			const skill = element as z.infer<typeof skillElement>;
			return [{ ...base, raw_text: skill.raw_text, polarity: skill.polarity }];
		}
		case 'experience_period': {
			const period = element as z.infer<typeof periodElement>;
			return [{ ...base, raw_text: period.quote, period_from: period.date_from, period_to: period.date_to }];
		}
		case 'education':
			return [{ ...base, raw_text: (element as z.infer<typeof educationElement>).institution }];
		case 'language_level': {
			const language = element as z.infer<typeof languageElement>;
			const level = stated(language.level);
			const quote = lineNaming(language.quote, language.language);
			const name = languageName(language.language);
			const languageItem = { ...base, raw_text: name, quote, ...(level === undefined ? {} : { level }) };
			// A language the taxonomy has as a skill («Английский» — `english`), stated with its level, is that skill as well,
			// as the rules read it; a language named without a level asserts no skill.
			const asSkill = level !== undefined && lexicon.aliasesOf(name).length > 0;
			return asSkill ? [languageItem, { ...base, kind: 'skill_mention', raw_text: name, quote }] : [languageItem];
		}
		default:
			return [{ ...base, raw_text: (element as z.infer<typeof textElement>).raw_text }];
	}
}

/**
 * Checks every element of a parsed answer. Job `n` (from 1) groups its facts as `job-n`; a refused element is kept
 * in the rejections with its kind and, for a job's element, its group.
 */
export function checkResumeAnswer(
	answer: z.infer<typeof resumeEnvelopeSchema>,
	blocks: readonly Block[],
	lexicon: SkillLexicon
): CheckedItems<ResumeItem> {
	const byId = new Map(blocks.map((block) => [block.id, block]));
	const accepted: ResumeItem[] = [];
	const rejected: Rejected[] = [];

	const checkElement = (kind: ResumeItemKind, schema: z.ZodObject, raw: unknown, group: string | undefined): void => {
		const where = { kind, ...(group === undefined ? {} : { group }) };
		const schemaFailure = itemSchemaFailure(schema, ['polarity', 'level'], raw);
		if (schemaFailure) {
			rejected.push({ item: { ...where, element: schemaFailure.item }, reason: schemaFailure.reason });
			return;
		}
		const element = raw as Record<string, unknown>;
		for (const candidate of candidatesOf(kind, element, group, lexicon)) {
			const checked = checkCandidate(candidate, byId, lexicon);
			if (checked.ok) accepted.push(checked.item);
			else rejected.push({ item: { ...where, kind: candidate.kind, element }, reason: checked.reason });
		}
	};

	answer.jobs.forEach((rawJob, index) => {
		const group = `job-${index + 1}`;
		const job = jobEnvelopeSchema.safeParse(rawJob);
		if (!job.success) {
			rejected.push({ item: { group, element: rawJob }, reason: 'schema_violation' });
			return;
		}
		for (const key of JOB_KEYS) {
			const { kind, schema } = JOB_ARRAYS[key];
			for (const raw of job.data[key]) checkElement(kind, schema, raw, group);
		}
	});
	for (const key of RESUME_KEYS) {
		const { kind, schema } = RESUME_ARRAYS[key];
		for (const raw of answer[key]) checkElement(kind, schema, raw, undefined);
	}
	return { items: dropRepeats(dropIncompleteGroups(accepted, rejected), rejected), rejected };
}

const HEADING_KINDS: readonly ResumeItemKind[] = ['role_title', 'organization', 'experience_period'];

/** The item's kind, value and place: one quote may state several items («Git, Jira»). */
const placeOf = (item: ResumeItem) =>
	`${item.kind}@${item.quote.blockId}:${item.quote.start}-${item.quote.end}:${fold(item.rawText)}`;

/**
 * The place of a job in the resume: its dates, which a resume writes once per job, or, for a job without dates, its
 * whole heading (title, organization).
 */
function jobPlaces(accepted: readonly ResumeItem[]): Map<string, string> {
	const headings = new Map<string, ResumeItem[]>();
	for (const item of accepted) {
		if (item.group === null || !HEADING_KINDS.includes(item.kind)) continue;
		headings.set(item.group, [...(headings.get(item.group) ?? []), item]);
	}
	const places = new Map<string, string>();
	for (const [group, heading] of headings) {
		const dates = heading.filter((item) => item.kind === 'experience_period');
		places.set(group, (dates.length > 0 ? dates : heading).map(placeOf).sort().join('|'));
	}
	return places;
}

/**
 * What the answer says twice is said once. A greedy model sometimes repeats a job it has already given, often with the
 * wanted position from the top of the resume as its title, or gives a fact of a job again outside it. A job at the
 * place of an earlier job is that job: its facts join the earlier one, and a title, organization or dates of a kind
 * the earlier job already has are a repeat. An item of the same kind and text at the same place as an earlier one is
 * the same item. The first one stays; the jobs come first, so a fact keeps its job.
 */
function dropRepeats(accepted: readonly ResumeItem[], rejected: Rejected[]): ResumeItem[] {
	const firstAtPlace = new Map<string, string>();
	const sameJob = new Map<string, string>();
	for (const [group, place] of jobPlaces(accepted)) {
		const first = firstAtPlace.get(place);
		if (first === undefined) firstAtPlace.set(place, group);
		else sameJob.set(group, first);
	}
	const headingKinds = new Set<string>();
	const seen = new Set<string>();
	const kept: ResumeItem[] = [];
	for (const found of accepted) {
		const group = found.group === null ? null : (sameJob.get(found.group) ?? found.group);
		const item = group === found.group ? found : { ...found, group };
		const heading = group !== null && HEADING_KINDS.includes(item.kind) ? `${group}:${item.kind}` : null;
		const repeatedHeading = heading !== null && found.group !== group && headingKinds.has(heading);
		if (repeatedHeading || seen.has(placeOf(item))) {
			rejected.push({ item: found, reason: 'duplicate' });
			continue;
		}
		if (heading !== null) headingKinds.add(heading);
		seen.add(placeOf(item));
		kept.push(item);
	}
	return kept;
}

export function prepareResumeExtract(lexicon: SkillLexicon): PreparedExtract<ResumeItem> {
	return {
		schemaName: 'resume_extract_v2',
		jsonSchema: RESUME_EXTRACT_JSON_SCHEMA,
		systemPrompt: RESUME_SYSTEM_PROMPT,
		check: (answer, blocks) => {
			const envelope = resumeEnvelopeSchema.safeParse(answer);
			if (!envelope.success) {
				return {
					ok: false,
					problem: `the answer must be an object with the arrays jobs, ${RESUME_KEYS.join(', ')}`
				};
			}
			return { ok: true, checked: checkResumeAnswer(envelope.data, blocks, lexicon) };
		}
	};
}
