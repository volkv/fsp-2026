// Normalization of an external posting to the taxonomy (docs/domain.md, sections 11, 13.2): role, grade, skills, salary
// range and work terms, each with the method it was found by. Deterministic rules only; what the rules do not
// recognize stays `null` — an unknown grade or salary is shown as «не указано», never guessed. The input is what the
// posting stores (`title`, `original_terms`), so a posting can be normalized again under a new taxonomy version.
import { z } from 'zod';
import { containsTerm } from '$lib/server/ml/quotes';
import { normalizeSkillText } from '$lib/server/taxonomy/normalize';
import { foldTitle, roleOfTitle as roleOfTitleRules, ROLE_TITLE_RULES_VERSION } from '$lib/server/taxonomy/roles';
import type { SourcePosting } from './sources/types';
import { resolveSkill, resolveSkillExactly, type VacancyTaxonomy } from './taxonomy';

/** The rules of this module and the title rules of roles they use. */
export const NORMALIZATION_RULES_VERSION = `vacancy-normalize/3+${ROLE_TITLE_RULES_VERSION}`;

/** `vacancy_postings.normalization_version`: the rules and the taxonomy version they ran against. */
export const normalizationVersion = (taxonomy: VacancyTaxonomy) => `${NORMALIZATION_RULES_VERSION}+${taxonomy.label}`;

// --- What a posting stores (`original_terms`): the white list of fields as the source wrote them ---

const salarySchema = z.object({
	min: z.int().nonnegative().nullable(),
	max: z.int().nonnegative().nullable(),
	currency: z.string().nullable(),
	period: z.enum(['month', 'year', 'hour', 'project']).nullable(),
	tax_base: z.enum(['gross', 'net']).nullable()
});

export const originalTermsSchema = z.object({
	salary_text: z.string().nullable(),
	salary: salarySchema,
	grade_raw: z.string().nullable(),
	employment_raw: z.string().nullable(),
	location: z.object({ city: z.string().nullable(), remote: z.boolean().nullable(), raw: z.string().nullable() }),
	skills_raw: z.array(z.string()),
	/** Stored only when the terms of the source allow it; contacts are already removed. */
	description: z.string().nullable(),
	contacts_removed: z.boolean()
});

export type OriginalTerms = z.infer<typeof originalTermsSchema>;

export function originalTermsOf(posting: SourcePosting, storeDescription: boolean): OriginalTerms {
	return {
		salary_text: posting.salary.rawText,
		salary: {
			min: posting.salary.min,
			max: posting.salary.max,
			currency: posting.salary.currency,
			period: posting.salary.period,
			tax_base: posting.salary.taxBase
		},
		grade_raw: posting.grade?.raw ?? null,
		employment_raw: posting.employment?.raw ?? null,
		location: posting.location,
		skills_raw: posting.skillsRaw,
		description: storeDescription ? posting.description : null,
		contacts_removed: storeDescription && posting.contactsRemoved
	};
}

// --- Normalized posting (`normalized`) ---

export type RoleMethod = 'title_rules' | 'none';
export type GradeMethod = 'source_field' | 'title_rules' | 'none';
export type SkillMethod = 'source_tag' | 'title' | 'text_scan';

export interface NormalizedSalary {
	status: 'stated' | 'absent' | 'unusable';
	/** Why a stated salary cannot be stored as a range: `currency_unknown`, `period_unknown`. */
	reason: string | null;
	min: number | null;
	max: number | null;
	currency: string | null;
	period: 'month' | 'year' | 'hour' | 'project' | null;
	tax_base: 'gross' | 'net' | 'unknown' | null;
}

export interface NormalizedPosting {
	rules_version: string;
	role: { key: string | null; method: RoleMethod; rule: string | null };
	grade: { min: string | null; max: string | null; basis: 'stated' | 'inferred' | 'unknown'; method: GradeMethod };
	skills: {
		required: string[];
		nice: string[];
		/** Mentions the taxonomy does not know, as written. */
		unknown: string[];
		methods: Record<string, SkillMethod>;
	};
	salary: NormalizedSalary;
	work_format: string | null;
	employment_form: string | null;
	city: string | null;
}

export const normalizedPostingSchema: z.ZodType<NormalizedPosting> = z.object({
	rules_version: z.string(),
	role: z.object({
		key: z.string().nullable(),
		method: z.enum(['title_rules', 'none']),
		rule: z.string().nullable()
	}),
	grade: z.object({
		min: z.string().nullable(),
		max: z.string().nullable(),
		basis: z.enum(['stated', 'inferred', 'unknown']),
		method: z.enum(['source_field', 'title_rules', 'none'])
	}),
	skills: z.object({
		required: z.array(z.string()),
		nice: z.array(z.string()),
		unknown: z.array(z.string()),
		methods: z.record(z.string(), z.enum(['source_tag', 'title', 'text_scan']))
	}),
	salary: z.object({
		status: z.enum(['stated', 'absent', 'unusable']),
		reason: z.string().nullable(),
		min: z.int().nullable(),
		max: z.int().nullable(),
		currency: z.string().nullable(),
		period: z.enum(['month', 'year', 'hour', 'project']).nullable(),
		tax_base: z.enum(['gross', 'net', 'unknown']).nullable()
	}),
	work_format: z.string().nullable(),
	employment_form: z.string().nullable(),
	city: z.string().nullable()
});

// --- Role by title ---

export function roleOfTitle(title: string, taxonomy: VacancyTaxonomy): NormalizedPosting['role'] {
	const key = roleOfTitleRules(title, taxonomy.roleNames);
	return key === null ? { key: null, method: 'none', rule: null } : { key, method: 'title_rules', rule: key };
}

// --- Grade ---

const w = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})`, 'u');

const GRADE_WORDS: readonly { grade: string; pattern: RegExp }[] = [
	{ grade: 'intern', pattern: w('intern|стажер|стажировк') },
	{ grade: 'junior', pattern: w('junior|джуниор|младш') },
	{ grade: 'middle', pattern: w('middle|мидл') },
	{ grade: 'senior', pattern: w('senior|сеньор|синьор|старш|ведущ') },
	{ grade: 'lead', pattern: w('lead(?![\\p{L}])|тимлид|team ?lead|tech ?lead') },
	{ grade: 'principal', pattern: w('principal') }
];

function gradesIn(text: string): string[] {
	const folded = foldTitle(text);
	return GRADE_WORDS.filter((g) => g.pattern.test(folded)).map((g) => g.grade);
}

function gradeRange(keys: readonly string[], taxonomy: VacancyTaxonomy): { min: string; max: string } | null {
	const known = keys.filter((k) => taxonomy.grades.includes(k));
	if (known.length === 0) return null;
	const ordered = [...known].sort((a, b) => taxonomy.grades.indexOf(a) - taxonomy.grades.indexOf(b));
	const min = ordered[0];
	const max = ordered.at(-1);
	return min !== undefined && max !== undefined ? { min, max } : null;
}

/** The range of the grade words a text names: «Middle/Senior» is middle to senior; `null` — it names none. */
export function gradeRangeIn(text: string, taxonomy: VacancyTaxonomy): { min: string; max: string } | null {
	return gradeRange(gradesIn(text), taxonomy);
}

/** The grade field of the source counts only when it consists of grade words («Senior», «middle, senior»). */
function stated(raw: string): string[] | null {
	const parts = foldTitle(raw)
		.split(/[,/;]|\s+(?:и|or|или)\s+/u)
		.map((p) => p.trim())
		.filter((p) => p !== '');
	if (parts.length === 0) return null;
	const keys: string[] = [];
	for (const part of parts) {
		const found = GRADE_WORDS.find((g) => g.pattern.test(part) && part.split(' ').length <= 2);
		if (!found) return null;
		keys.push(found.grade);
	}
	return keys;
}

export function gradeOf(title: string, gradeRaw: string | null, taxonomy: VacancyTaxonomy): NormalizedPosting['grade'] {
	if (gradeRaw !== null) {
		const keys = stated(gradeRaw);
		const range = keys ? gradeRange(keys, taxonomy) : null;
		if (range) return { ...range, basis: 'stated', method: 'source_field' };
	}
	const range = gradeRange(gradesIn(title), taxonomy);
	if (range) return { ...range, basis: 'inferred', method: 'title_rules' };
	return { min: null, max: null, basis: 'unknown', method: 'none' };
}

// --- Skills ---

/** Lead-in phrases of a skill requirement («Навык работы с PHP»); a tag of a source may glue them to the name. */
const LEAD_INS = [
	'навык работы с',
	'навыки работы с',
	'владение',
	'знание',
	'знания',
	'опыт работы с',
	'опыт работы в',
	'умение работать с',
	'работа с',
	'работать с',
	'работать в',
	'разработка под',
	'разработка на',
	'программирование на'
];
const leadIn = (phrases: readonly string[], tail: string) => new RegExp(`^(?:${phrases.join('|')})${tail}`, 'iu');
const SPACED_LEAD_IN = leadIn(LEAD_INS, '\\s+');
const GLUED_LEAD_IN = leadIn(
	LEAD_INS.map((phrase) => phrase.replaceAll(' ', '')),
	'(?=\\S)'
);

/**
 * Vendors a tag written without spaces starts with («MicrosoftExcel», «AutodeskRevit»): the product is tried with the
 * short name of the vendor the taxonomy uses and without the vendor.
 */
const VENDORS: Readonly<Record<string, string | null>> = {
	microsoft: 'ms',
	apache: null,
	autodesk: null,
	google: null,
	yandex: null,
	amazon: null,
	oracle: null,
	adobe: null,
	atlassian: null,
	jetbrains: null
};

/** Words of a tag glued together: «MicrosoftExcel» → «Microsoft Excel», «оборудованияCisco» → «оборудования Cisco». */
function unglue(raw: string): string {
	return raw
		.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
		.replace(/(\p{Script=Cyrillic})(?=[\p{Script=Latin}\p{N}])/gu, '$1 ')
		.replace(/(\p{Script=Latin})(?=\p{Script=Cyrillic})/gu, '$1 ');
}

/** Candidates a raw tag may stand for: as written, without a lead-in phrase, and each side of «Name (Alias)». */
function spellings(raw: string): string[] {
	const trimmed = raw.trim();
	const stripped = trimmed.replace(SPACED_LEAD_IN, '');
	const result = [trimmed, stripped];
	const paren = /^(.*?)\s*\(([^()]+)\)\s*$/u.exec(stripped);
	if (paren) result.push(paren[1] ?? '', paren[2] ?? '');
	for (const part of stripped.split(/\s*\/\s*/u)) result.push(part);
	return [...new Set(result.filter((s) => s !== ''))];
}

/**
 * Narrower candidates of a tag written without spaces, tried only by an exact alias: the product line before a colon
 * («1C:ERP» → «1C»), the product of a vendor («MicrosoftSQL» → «MS SQL», «SQL»), the name after a glued lead-in
 * («Разработкапод1С» → «1С») and a Latin name glued to Russian words («АдминистрированиеоборудованияCisco» → «Cisco»).
 */
function gluedSpellings(raw: string): string[] {
	const trimmed = raw.trim();
	const result: string[] = [];
	const product = /^([^:\s]+):\S/u.exec(trimmed);
	if (product?.[1]) result.push(product[1]);
	const words = unglue(trimmed).split(/\s+/u);
	const [first, ...rest] = words;
	const vendor = first === undefined ? undefined : VENDORS[first.toLowerCase()];
	if (vendor !== undefined && rest.length > 0) {
		if (vendor !== null) result.push([vendor, ...rest].join(' '));
		result.push(rest.join(' '));
	}
	const afterLeadIn = trimmed.replace(GLUED_LEAD_IN, '');
	if (afterLeadIn !== trimmed) result.push(afterLeadIn);
	if (/\p{Script=Cyrillic}/u.test(trimmed)) {
		for (const run of trimmed.match(/[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}+#.]*/gu) ?? []) {
			if (/\p{Script=Latin}/u.test(run)) result.push(run);
		}
	}
	return [...new Set(result)];
}

/** Aliases a free text is scanned for: single letters and two-letter words are too ambiguous in prose. */
function scannableAliases(taxonomy: VacancyTaxonomy): { alias: string; skill: string }[] {
	const list: { alias: string; skill: string }[] = [];
	for (const [skill, aliases] of taxonomy.aliasesBySkill) {
		for (const alias of aliases) {
			if (Array.from(alias).length >= 3 || /[+#.]/u.test(alias)) list.push({ alias, skill });
		}
	}
	return list;
}

const scanCache = new WeakMap<VacancyTaxonomy, { alias: string; skill: string }[]>();

function scan(text: string, taxonomy: VacancyTaxonomy): Set<string> {
	let aliases = scanCache.get(taxonomy);
	if (!aliases) {
		aliases = scannableAliases(taxonomy);
		scanCache.set(taxonomy, aliases);
	}
	const normalized = normalizeSkillText(text);
	const found = new Set<string>();
	for (const { alias, skill } of aliases) {
		if (!found.has(skill) && containsTerm(normalized, alias)) found.add(skill);
	}
	return found;
}

export function skillsOf(title: string, terms: OriginalTerms, taxonomy: VacancyTaxonomy): NormalizedPosting['skills'] {
	const methods: Record<string, SkillMethod> = {};
	const required: string[] = [];
	const nice: string[] = [];
	const unknown: string[] = [];
	const add = (key: string, method: SkillMethod, list: string[]) => {
		if (key in methods) return;
		methods[key] = method;
		list.push(key);
	};
	for (const raw of terms.skills_raw) {
		const key =
			spellings(raw)
				.map((s) => resolveSkill(taxonomy, s))
				.find((k): k is string => k !== null) ??
			gluedSpellings(raw)
				.map((s) => resolveSkillExactly(taxonomy, s))
				.find((k): k is string => k !== null);
		if (key === undefined) unknown.push(raw);
		else add(key, 'source_tag', required);
	}
	for (const key of scan(title, taxonomy)) add(key, 'title', required);
	if (terms.description !== null) for (const key of scan(terms.description, taxonomy)) add(key, 'text_scan', nice);
	return { required, nice, unknown: [...new Set(unknown)], methods };
}

// --- Salary and work terms ---

export function salaryOf(terms: OriginalTerms): NormalizedSalary {
	const { min, max, currency, period, tax_base } = terms.salary;
	const none = { min: null, max: null, currency: null, period: null, tax_base: null };
	if (min === null && max === null) return { status: 'absent', reason: null, ...none };
	if (currency === null || !/^[A-Z]{3}$/u.test(currency))
		return { status: 'unusable', reason: 'currency_unknown', ...none };
	if (period === null) return { status: 'unusable', reason: 'period_unknown', ...none };
	if (min !== null && max !== null && min > max) return { status: 'unusable', reason: 'bounds_reversed', ...none };
	return { status: 'stated', reason: null, min, max, currency, period, tax_base: tax_base ?? 'unknown' };
}

const EMPLOYMENT_RULES: readonly { key: string; pattern: RegExp }[] = [
	{ key: 'internship', pattern: w('стажир|internship') },
	{ key: 'part', pattern: w('частичн|неполн|part time|part_time') },
	{ key: 'project', pattern: w('проектн|временн|contract') },
	{ key: 'full', pattern: w('полн\\p{L}* (?:занятост|рабоч)|полный день|full time|full_time') }
];

function employmentOf(raw: string | null, taxonomy: VacancyTaxonomy): string | null {
	if (raw === null) return null;
	const folded = foldTitle(raw);
	const rule = EMPLOYMENT_RULES.find((r) => r.pattern.test(folded) && taxonomy.terms.employment_form.includes(r.key));
	return rule?.key ?? null;
}

function workFormatOf(terms: OriginalTerms, title: string, taxonomy: VacancyTaxonomy): string | null {
	const text = foldTitle([terms.employment_raw ?? '', terms.location.raw ?? '', title].join(' '));
	const has = (key: string) => taxonomy.terms.work_format.includes(key);
	if (w('гибрид|hybrid').test(text) && has('hybrid')) return 'hybrid';
	if (terms.location.remote === true && has('remote')) return 'remote';
	if (w('удален|дистанцион|remote').test(text) && has('remote')) return 'remote';
	return null;
}

export function normalizePosting(title: string, terms: OriginalTerms, taxonomy: VacancyTaxonomy): NormalizedPosting {
	return {
		rules_version: NORMALIZATION_RULES_VERSION,
		role: roleOfTitle(title, taxonomy),
		grade: gradeOf(title, terms.grade_raw, taxonomy),
		skills: skillsOf(title, terms, taxonomy),
		salary: salaryOf(terms),
		work_format: workFormatOf(terms, title, taxonomy),
		employment_form: employmentOf(terms.employment_raw, taxonomy),
		city: terms.location.city
	};
}
