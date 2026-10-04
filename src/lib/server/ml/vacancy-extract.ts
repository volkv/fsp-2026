// `vacancy-extract/v2`: fields of a vacancy draft from the text an employer pasted (docs/contracts.md, section 3.2;
// docs/domain.md, section 13.1). The result only suggests fields; the employer confirms them. Every element carries a
// quote and passes the same checks as a resume: the quote is in its block, the quote supports the value.
//
// The answer has one array per field, and every key of an element is required: structured output of the runtime
// accepts neither nullable types nor optional keys the model reliably fills, so a value the text does not state is
// written explicitly — `not_stated`, `unknown`, or 0 for a salary bound.
import { z } from 'zod';
import {
	NOT_STATED,
	flatJsonSchema,
	itemSchemaFailure,
	locateItemQuote,
	type CheckedItems,
	type PreparedExtract,
	type Rejected
} from './extract-common';
import { vacancySystemPrompt } from './prompts';
import {
	POLARITIES,
	detectPolarity,
	fold,
	quoteNamesSkill,
	type Block,
	type Polarity,
	type QuoteLocation,
	type SkillLexicon
} from './quotes';

export const VACANCY_ITEM_KINDS = [
	'role_title',
	'grade',
	'required_skill',
	'nice_skill',
	'salary',
	'work_format',
	'employment_form',
	'contract_type',
	'city'
] as const;

export type VacancyItemKind = (typeof VACANCY_ITEM_KINDS)[number];

export const SALARY_PERIODS = ['month', 'year', 'hour', 'project'] as const;
export const TAX_BASES = ['gross', 'net', 'unknown'] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];
export type TaxBase = (typeof TAX_BASES)[number];

type TermKind = 'work_format' | 'employment_form' | 'contract_type';

/** Keys of one taxonomy version the answer may use (docs/domain.md, section 11). */
export interface VacancyLexicon extends SkillLexicon {
	/** Grade keys, lowest first. */
	grades: readonly string[];
	/** Keys of the work format dimensions. */
	terms: Readonly<Record<TermKind, readonly string[]>>;
}

/** Kind of the elements of each answer array. */
const ARRAYS = {
	role_titles: 'role_title',
	grades: 'grade',
	required_skills: 'required_skill',
	nice_skills: 'nice_skill',
	salaries: 'salary',
	work_formats: 'work_format',
	employment_forms: 'employment_form',
	contract_types: 'contract_type',
	cities: 'city'
} as const satisfies Record<string, VacancyItemKind>;

type ArrayKey = keyof typeof ARRAYS;
const ARRAY_KEYS = Object.keys(ARRAYS) as ArrayKey[];

function nonEmpty(values: readonly string[], what: string): [string, ...string[]] {
	const unique = [...new Set(values)];
	const [first, ...rest] = unique;
	if (first === undefined) throw new Error(`vacancy lexicon has no ${what}`);
	return [first, ...rest];
}

const located = { block_id: z.string(), quote: z.string() };

/** Element schemas of one taxonomy version, one per answer array. */
function elementSchemas(lexicon: VacancyLexicon) {
	const grade = z.enum([...nonEmpty(lexicon.grades, 'grades'), NOT_STATED]);
	const term = (kind: TermKind) =>
		z.strictObject({ raw_text: z.string(), value: z.enum(nonEmpty(lexicon.terms[kind], kind)), ...located });
	const skill = z.strictObject({ raw_text: z.string(), polarity: z.enum(POLARITIES), ...located });
	const text = z.strictObject({ raw_text: z.string(), ...located });
	return {
		role_titles: text,
		grades: z.strictObject({ raw_text: z.string(), grade_min: grade, grade_max: grade, ...located }),
		required_skills: skill,
		nice_skills: skill,
		salaries: z.strictObject({
			raw_text: z.string(),
			/** 0 — the text states no such bound. */
			salary_min: z.int().nonnegative(),
			salary_max: z.int().nonnegative(),
			currency: z.string().regex(/^([A-Z]{3}|not_stated)$/),
			period: z.enum([...SALARY_PERIODS, NOT_STATED]),
			tax_base: z.enum(TAX_BASES),
			...located
		}),
		work_formats: term('work_format'),
		employment_forms: term('employment_form'),
		contract_types: term('contract_type'),
		cities: text
	} satisfies Record<ArrayKey, z.ZodObject>;
}

type Elements = ReturnType<typeof elementSchemas>;
type Element<K extends ArrayKey> = z.infer<Elements[K]>;

/** Keys whose values come from a fixed list: a value outside it is `unknown_enum`. */
const ENUM_KEYS = ['polarity', 'grade_min', 'grade_max', 'value', 'period', 'tax_base'];

export function vacancyAnswerSchema(lexicon: VacancyLexicon) {
	const elements = elementSchemas(lexicon);
	return z.strictObject(
		Object.fromEntries(ARRAY_KEYS.map((key) => [key, z.array(elements[key])])) as {
			[K in ArrayKey]: z.ZodArray<Elements[K]>;
		}
	);
}

const envelopeSchema = z.object(
	Object.fromEntries(ARRAY_KEYS.map((key) => [key, z.array(z.unknown())])) as Record<ArrayKey, z.ZodArray<z.ZodUnknown>>
);

export interface VacancySalary {
	min: number | null;
	max: number | null;
	/** ISO 4217; `null` when the text names no currency. */
	currency: string | null;
	period: SalaryPeriod | null;
	taxBase: TaxBase;
}

export interface VacancyItem {
	kind: VacancyItemKind;
	rawText: string;
	/** Skills only: final polarity after the negation detector («Java не требуется» is `negated`). */
	polarity: Polarity | null;
	modelPolarity: Polarity | null;
	/** `grade`: a range of grade keys; one end may be open. */
	grade: { min: string | null; max: string | null } | null;
	/** `work_format`, `employment_form`, `contract_type`: the taxonomy key. */
	value: string | null;
	salary: VacancySalary | null;
	quote: QuoteLocation;
}

const stated = <T extends string>(value: T | typeof NOT_STATED): T | null => (value === NOT_STATED ? null : value);
const bound = (amount: number): number | null => (amount === 0 ? null : amount);

/** The values of the element say nothing or contradict each other: no grade or amount at all, `min` above `max`. */
function inconsistent(key: ArrayKey, element: Record<string, unknown>, lexicon: VacancyLexicon): boolean {
	if (key === 'grades') {
		const { grade_min: min, grade_max: max } = element as Element<'grades'>;
		if (min === NOT_STATED && max === NOT_STATED) return true;
		return min !== NOT_STATED && max !== NOT_STATED && lexicon.grades.indexOf(min) > lexicon.grades.indexOf(max);
	}
	if (key === 'salaries') {
		const { salary_min: min, salary_max: max } = element as Element<'salaries'>;
		if (min === 0 && max === 0) return true;
		return min !== 0 && max !== 0 && min > max;
	}
	return false;
}

const NUMBER =
	/(?<![\p{L}\p{N}])(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,](\d{1,2}))?(?:\s*(k|к|тыс\.?|тысяч\p{L}*|млн))?(?![\p{L}\p{N}])/giu;

const MULTIPLIERS: Record<string, number> = { k: 1_000, к: 1_000, тыс: 1_000, 'тыс.': 1_000, млн: 1_000_000 };

/** What joins the two ends of a range: a dash or «до» — «120–160 тыс.», «от 120 до 160 тыс.», «200 - 250k». */
const RANGE_JOIN = /^\s*(?:[-–—]|до)\s*$/u;

/**
 * Amounts written in the quote: «200 000», «200k», «200 тыс.», «1,5 млн». The first end of a range takes the unit of
 * the second one when it has none and, as written, is not above it: «120–160 тыс.» and «от 120 до 160 тыс.» are
 * 120 000 and 160 000, while «150 000 – 2 млн» is read as written.
 */
export function amountsIn(quote: string): Set<number> {
	const read = Array.from(quote.matchAll(NUMBER), (match) => {
		const [text, whole = '', fraction, suffix] = match;
		const unit = suffix?.toLocaleLowerCase('ru');
		return {
			base: Number(`${whole.replace(/[ \u00a0\u202f]/gu, '')}.${fraction ?? '0'}`),
			multiplier: unit === undefined ? null : unit.startsWith('тысяч') ? 1_000 : (MULTIPLIERS[unit] ?? 1),
			start: match.index,
			end: match.index + text.length
		};
	});
	const amounts = new Set<number>();
	read.forEach((amount, index) => {
		const next = read[index + 1];
		const sharedUnit =
			amount.multiplier === null &&
			next?.multiplier != null &&
			RANGE_JOIN.test(quote.slice(amount.end, next.start)) &&
			amount.base <= next.base
				? next.multiplier
				: null;
		amounts.add(Math.round(amount.base * (amount.multiplier ?? sharedUnit ?? 1)));
	});
	return amounts;
}

const word = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})`, 'u');

const CURRENCY_MARKERS: Record<string, RegExp> = {
	RUB: /₽|(?<![\p{L}])(?:руб|р\.|rub|rur)/u,
	USD: /\$|(?<![\p{L}])(?:usd|долл)/u,
	EUR: /€|(?<![\p{L}])(?:eur|евро)/u
};

const PERIOD_MARKERS: Record<SalaryPeriod, RegExp> = {
	month: word('мес|month|monthly|\\/\\s*m(?![\\p{L}])'),
	year: word('год|в год|year|annual|annually'),
	hour: word('час|hour|hourly|\\/\\s*h(?![\\p{L}])'),
	project: word('проект|project')
};

const TAX_MARKERS: Record<'gross' | 'net', RegExp> = {
	gross: word('до вычета|до налог|до ндфл|до уплаты|gross|брутто'),
	net: word('на руки|после вычета|после налог|после уплаты|net(?![\\p{L}])|нетто|чистыми')
};

/** Every stated part of the salary is written in the quote; `unknown` tax base needs no marker. */
function salarySupported(salary: VacancySalary, quote: string): boolean {
	const text = fold(quote);
	const amounts = amountsIn(quote);
	for (const amount of [salary.min, salary.max]) {
		if (amount !== null && !amounts.has(amount)) return false;
	}
	if (salary.currency !== null) {
		const marker = CURRENCY_MARKERS[salary.currency] ?? word(salary.currency.toLowerCase());
		if (!marker.test(text)) return false;
	}
	if (salary.period !== null && !PERIOD_MARKERS[salary.period].test(text)) return false;
	if (salary.taxBase === 'gross' || salary.taxBase === 'net') return TAX_MARKERS[salary.taxBase].test(text);
	return true;
}

const OFFICE = word('офис|office|on-?site');
const REMOTE = word('удал[её]нн?\\p{L}*|удал[её]нк\\p{L}*|дистанц\\p{L}*|remote|из дома');

/**
 * Words that state a work term key of the taxonomy (taxonomy/work-formats.json). A key the product has no words for
 * is supported by its raw text alone.
 */
const TERM_MARKERS: Record<string, (text: string) => boolean> = {
	office: (text) => OFFICE.test(text),
	remote: (text) => REMOTE.test(text),
	// «3 дня в офисе, 2 дня удалённо» is a hybrid without the word.
	hybrid: (text) => word('гибрид|hybrid').test(text) || (OFFICE.test(text) && REMOTE.test(text)),
	full: (text) => word('полн\\p{L}*|full[- ]?time').test(text),
	part: (text) => word('частичн\\p{L}*|неполн\\p{L}*|part[- ]?time').test(text),
	project: (text) => word('проектн\\p{L}*|контракт\\p{L}*|временн\\p{L}*|project|contract').test(text),
	internship: (text) => word('стажир\\p{L}*|стаж[её]р\\p{L}*|intern\\p{L}*').test(text),
	side_job: (text) => word('подработ\\p{L}*|совместительств\\p{L}*|side job').test(text),
	labor: (text) => word('трудов\\p{L}* договор|тк(?![\\p{L}])|штат\\p{L}*|labou?r contract').test(text),
	gph: (text) => word('гпх|гражданско-правов\\p{L}*').test(text),
	self_employed: (text) => word('самозанят\\p{L}*|нпд|self[- ]employed').test(text),
	ip: (text) => word('ип(?![\\p{L}])|индивидуальн\\p{L}* предпринимател\\p{L}*').test(text)
};

/** The quote states the term key; the raw text alone when the key has no words. */
function termSupported(value: string, rawText: string, quote: string): boolean {
	const text = fold(quote);
	const markers = TERM_MARKERS[value];
	return markers ? markers(text) : text.includes(fold(rawText));
}

/** A word without the case ending a Russian place name takes in a sentence («Москва» — «в Москве»). */
function stemOf(name: string): string {
	const letters = Array.from(name);
	if (letters.length >= 6) return letters.slice(0, -2).join('');
	if (letters.length >= 4) return letters.slice(0, -1).join('');
	return name;
}

/** Every word of the place name starts a word of the quote, up to its case ending. */
function namesPlace(quote: string, rawText: string): boolean {
	const words = fold(quote).split(/[^\p{L}\p{N}-]+/u);
	const named = fold(rawText)
		.split(/[^\p{L}\p{N}-]+/u)
		.filter((part) => part !== '');
	return named.length > 0 && named.every((part) => words.some((candidate) => candidate.startsWith(stemOf(part))));
}

function quoteSupports(item: Omit<VacancyItem, 'quote'>, quote: string, lexicon: VacancyLexicon): boolean {
	switch (item.kind) {
		case 'required_skill':
		case 'nice_skill':
			return quoteNamesSkill(quote, item.rawText, lexicon);
		case 'salary':
			return item.salary !== null && salarySupported(item.salary, quote);
		case 'work_format':
		case 'employment_form':
		case 'contract_type':
			return item.value !== null && termSupported(item.value, item.rawText, quote);
		case 'city':
			return namesPlace(quote, item.rawText);
		default:
			return fold(quote).includes(fold(item.rawText));
	}
}

/** The item an element stands for, before its quote is located. */
function itemOf(key: ArrayKey, element: Record<string, unknown>): Omit<VacancyItem, 'quote'> {
	const kind = ARRAYS[key];
	const item: Omit<VacancyItem, 'quote'> = {
		kind,
		rawText: element.raw_text as string,
		polarity: null,
		modelPolarity: null,
		grade: null,
		value: null,
		salary: null
	};
	switch (key) {
		case 'grades': {
			const { grade_min: min, grade_max: max } = element as Element<'grades'>;
			return { ...item, grade: { min: stated(min), max: stated(max) } };
		}
		case 'required_skills':
		case 'nice_skills':
			return { ...item, modelPolarity: (element as Element<'required_skills'>).polarity };
		case 'salaries': {
			const salary = element as Element<'salaries'>;
			return {
				...item,
				salary: {
					min: bound(salary.salary_min),
					max: bound(salary.salary_max),
					currency: stated(salary.currency),
					period: stated<SalaryPeriod>(salary.period),
					taxBase: salary.tax_base
				}
			};
		}
		case 'work_formats':
		case 'employment_forms':
		case 'contract_types':
			return { ...item, value: (element as Element<'work_formats'>).value };
		default:
			return item;
	}
}

/** Checks every element of a parsed answer; elements are returned in the order of the answer arrays. */
export function checkVacancyAnswer(
	answer: Record<ArrayKey, readonly unknown[]>,
	blocks: readonly Block[],
	lexicon: VacancyLexicon
): CheckedItems<VacancyItem> {
	const schemas = elementSchemas(lexicon);
	const byId = new Map(blocks.map((block) => [block.id, block]));
	const items: VacancyItem[] = [];
	const rejected: Rejected[] = [];

	for (const key of ARRAY_KEYS) {
		const kind = ARRAYS[key];
		for (const raw of answer[key]) {
			const schemaFailure = itemSchemaFailure(schemas[key], ENUM_KEYS, raw);
			if (schemaFailure) {
				rejected.push({ item: { kind, element: schemaFailure.item }, reason: schemaFailure.reason });
				continue;
			}
			const element = raw as Record<string, unknown>;
			if (inconsistent(key, element, lexicon)) {
				rejected.push({ item: { kind, element }, reason: 'schema_violation' });
				continue;
			}
			const found = locateItemQuote(byId, element.block_id as string, element.quote as string);
			if (!found.ok) {
				rejected.push({ item: { kind, element }, reason: found.reason });
				continue;
			}
			const item = itemOf(key, element);
			if (!quoteSupports(item, found.location.text, lexicon)) {
				rejected.push({ item: { kind, element }, reason: 'quote_not_supporting' });
				continue;
			}
			const polarity = item.modelPolarity && detectPolarity(item.modelPolarity, found.block.text, found.location);
			items.push({ ...item, polarity, quote: found.location });
		}
	}
	return { items, rejected };
}

export function prepareVacancyExtract(lexicon: VacancyLexicon): PreparedExtract<VacancyItem> {
	return {
		schemaName: 'vacancy_extract_v2',
		jsonSchema: flatJsonSchema(vacancyAnswerSchema(lexicon)),
		systemPrompt: vacancySystemPrompt(lexicon),
		check: (answer, blocks) => {
			const envelope = envelopeSchema.safeParse(answer);
			if (!envelope.success) {
				return { ok: false, problem: `the answer must be an object with the arrays ${ARRAY_KEYS.join(', ')}` };
			}
			return { ok: true, checked: checkVacancyAnswer(envelope.data, blocks, lexicon) };
		}
	};
}
