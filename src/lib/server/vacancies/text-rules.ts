// The deterministic reader of a pasted vacancy — the product's path without a model (docs/domain.md, section 13.1;
// contracts 3.2 `vacancy-extract/v2`). It answers in the shape of the model's answer, and its elements pass the same
// checks: the quote is found in its block and supports the value, the negation detector sets the polarity of a skill.
// It reads only what is written: the title line and its role and grade, skills of the taxonomy by their aliases, the
// range with its currency, period and tax base where the text states them, the work terms and the city.
import { NOT_STATED } from '$lib/server/ml/extract-common';
import type { Block } from '$lib/server/ml/quotes';
import { checkVacancyAnswer, type VacancyItem, type VacancyLexicon } from '$lib/server/ml/vacancy-extract';
import type { CheckedItems } from '$lib/server/ml/extract-common';
import { roleOfTitle, ROLE_TITLE_RULES_VERSION, TITLE_WORD } from '$lib/server/taxonomy/roles';
import { buildSkillReader, skillSpans, type SkillReader } from '$lib/server/taxonomy/skill-spans';
import { gradeRangeIn } from './normalize';
import type { VacancyTaxonomy } from './taxonomy';

/** Version of these rules (`ml_results.rules_version`): any change of what they find is a new version. */
export const VACANCY_TEXT_RULES_VERSION = `vacancy-text-rules/3+${ROLE_TITLE_RULES_VERSION}`;

const w = (pattern: string, flags = '') => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})`, `u${flags}`);

// --- Sections -------------------------------------------------------------------------------------------------------

type Section = 'requirements' | 'nice' | 'offer';

/** Headings of the parts of a vacancy; a skill is read in every part but the offer and the company. */
const HEADINGS: readonly [RegExp, Section][] = [
	[
		/^(?:будет плюсом|плюсом будет|будет преимуществом|преимуществом будет|большим плюсом|большой плюс|желательно|nice to have|будет здорово|приветствуется)/iu,
		'nice'
	],
	[
		/^(?:условия|мы предлагаем|что мы предлагаем|предлагаем|что мы да[её]м|что мы готовы предложить|о компании|о нас|бонусы|плюшки|контакты|как откликнуться|откликнуться|we offer|benefits|about us|about the company)/iu,
		'offer'
	],
	[
		/^(?:требования|обязательно|что (?:мы )?ожида\p{L}*|мы ожидаем|ждем|ждём|от вас|от тебя|необходимо|что нужно|нужно|must have|requirements|you have|наш стек|стек|технологии|tech stack|stack|ключевые навыки|навыки|обязанности|задачи|чем (?:предстоит|нужно|будешь|будете) заниматься|что (?:нужно |предстоит )?делать|предстоит|responsibilities|what you will do)/iu,
		'requirements'
	]
];

/** Longest line taken for a heading: a longer one is text that starts with a heading word. */
const MAX_HEADING = 60;

/** The section a line opens: a heading word alone on a short line or followed by a colon («Требования: Go, SQL»). */
function headingOf(line: string): Section | null {
	const text = line.replace(/^[^\p{L}\p{N}]+/u, '');
	for (const [pattern, section] of HEADINGS) {
		const match = pattern.exec(text);
		if (!match) continue;
		const rest = text.slice(match[0].length);
		if (/^[^\p{L}\p{N}]*:/u.test(rest)) return section;
		if (text.length <= MAX_HEADING && /^[\s\p{P}\p{S}]*$/u.test(rest)) return section;
	}
	return null;
}

/** A wish inside a line of requirements: «Kafka — будет плюсом», «желательно знание Go». */
const NICE_IN_LINE = w(
	'будет плюсом|плюсом будет|как плюс|будет преимуществом|преимуществом|желательно|приветствуется|is a plus|nice to have|preferred|is a bonus',
	'i'
);
/** The clause of a line around an offset: «Go, gRPC; Kubernetes будет плюсом» wishes only for Kubernetes. */
function clauseAt(line: string, offset: number): string {
	const start = Math.max(...[';', '. '].map((mark) => line.lastIndexOf(mark, offset))) + 1;
	const ends = [';', '. '].map((mark) => line.indexOf(mark, offset)).filter((index) => index >= 0);
	return line.slice(start, ends.length > 0 ? Math.min(...ends) : line.length);
}

/** A line with the contacts or the call to respond: «пришлите CV», «send your CV» name no requirement. */
const CONTACT_LINE = w(
	'откликнуться|отклик\\p{L}*|резюме|пишите|напишите|send (?:your|us)|apply|telegram|телеграм|e-?mail|почт\\p{L}*',
	'i'
);

// --- Title ------------------------------------------------------------------------------------------------------------

/** Lines looked at for the title: it opens a vacancy, after hashtags and a greeting at most. */
const TITLE_LINES = 5;
const MAX_TITLE = 120;
const TITLE_PREFIX = /^(?:вакансия|позиция|должность|vacancy|position|role|job opening)\s*[:—–-]?\s*/iu;
/** A title inside a sentence of search: «Ищем ведущего Go-разработчика в команду платежей». */
const SEARCH_LEAD =
	/^(?:мы\s+)?(?:ищем|ищет|приглашаем|в поиске|нужен|нужна|требуется|we(?:['’]re| are) looking for|looking for|hiring)\s+/iu;
/** Where the title of a sentence of search ends: the team, the purpose, a subordinate clause. */
const SEARCH_TAIL = /\s+(?:в|во|на|для|с|со|к|который|которая|которые|in|to|for|who|with)\s|[,.;!?(]|\s[—–-]\s/u;
const HASHTAG_LINE = /^(?:#[\p{L}\p{N}_]+[\s,]*)+$/u;

/** Trailing characters of a title that are part of it: «C++», «C#», «(Go)». */
const TITLE_TAIL = /[+#)]/u;

/** The title as written in the line: without leading symbols, the «Вакансия:» prefix and trailing punctuation. */
function titleText(line: string): string {
	const chars = Array.from(line.replace(/^[^\p{L}\p{N}]+/u, '').replace(TITLE_PREFIX, ''));
	while (chars.length > 0) {
		const last = chars.at(-1) ?? '';
		if (!/[\s\p{P}\p{S}]/u.test(last) || TITLE_TAIL.test(last)) break;
		chars.pop();
	}
	return chars.join('');
}

/** The title a line states: the line itself, or the position named by a sentence of search. */
function titleOf(line: string): string {
	const text = titleText(line);
	const lead = SEARCH_LEAD.exec(text);
	if (!lead) return text;
	const rest = text.slice(lead[0].length);
	const tail = SEARCH_TAIL.exec(rest);
	return titleText(tail ? rest.slice(0, tail.index) : rest);
}

/**
 * The title among the first lines: the line that opens the text or a line with a job word («Инженер-программист»), one
 * naming a role of the taxonomy first. Any other line is a sentence or a list: a stack line «Python, Airflow, Spark»
 * names tools, not the position, and never decides the role. Hashtags and headings are not titles.
 */
function findTitle(blocks: readonly Block[], taxonomy: VacancyTaxonomy): { block: Block; text: string } | null {
	const candidates = blocks
		.slice(0, TITLE_LINES)
		.filter((block) => !HASHTAG_LINE.test(block.text) && !headingOf(block.text))
		.map((block) => ({ block, text: titleOf(block.text) }))
		.filter(({ text }) => text.length >= 3 && text.length <= MAX_TITLE)
		.filter(({ text }, index) => index === 0 || TITLE_WORD.test(text));
	return (
		candidates.find(({ text }) => roleOfTitle(text, taxonomy.roleNames) !== null) ??
		candidates.find(({ text }) => TITLE_WORD.test(text)) ??
		null
	);
}

// --- Grade ------------------------------------------------------------------------------------------------------------

const GRADE_LINE = w('грейд|уровень|level|seniority|позиция', 'i');

/** The grade of the title, else of a hashtag line or a line naming the level («Грейд: Middle+»). */
function findGrade(
	blocks: readonly Block[],
	title: { block: Block; text: string } | null,
	taxonomy: VacancyTaxonomy
): { block: Block; text: string; range: { min: string; max: string } } | null {
	const candidates = [
		...(title ? [{ block: title.block, text: title.text }] : []),
		...blocks
			.filter((block) => HASHTAG_LINE.test(block.text) || (GRADE_LINE.test(block.text) && block.text.length <= 80))
			.map((block) => ({ block, text: block.text }))
	];
	for (const candidate of candidates) {
		const range = gradeRangeIn(candidate.text, taxonomy);
		if (range) return { ...candidate, range };
	}
	return null;
}

// --- Salary -----------------------------------------------------------------------------------------------------------

const SALARY_WORD = w(
	'зарплат\\p{L}*|з/п|зп|оклад\\p{L}*|доход\\p{L}*|вилк\\p{L}*|salary|компенсац\\p{L}*|вознагражден\\p{L}*',
	'i'
);
const CURRENCIES: readonly [string, RegExp][] = [
	['RUB', /₽|(?<![\p{L}])(?:руб|р\.|rub|rur)/iu],
	['USD', /\$|(?<![\p{L}])(?:usd|долл)/iu],
	['EUR', /€|(?<![\p{L}])(?:eur|евро)/iu]
];
const PERIODS: readonly ['month' | 'year' | 'hour', RegExp][] = [
	['hour', w('в час|/\\s*час|за час|per hour|hourly', 'i')],
	['year', w('в год|/\\s*год|за год|per year|annual\\p{L}*|годов\\p{L}* (?:доход|оклад|зарплат)', 'i')],
	['month', w('в месяц|/\\s*мес|за месяц|мес\\.|месяц|per month|monthly', 'i')]
];
const TAX_BASES: readonly ['gross' | 'net', RegExp][] = [
	['net', w('на руки|после вычета|после налог|net(?![\\p{L}])|нетто|чистыми', 'i')],
	['gross', w('до вычета|до налог|до ндфл|gross|брутто', 'i')]
];

const NUMBER = String.raw`(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,](\d{1,2}))?(?:\s*(k|к|тыс\.?|тысяч\p{L}*|млн))?(?![\p{L}\p{N}])`;
/** «от 200 000 до 300 000», «200–300 тыс.», «от 250k», «до 400 000». */
const RANGE = new RegExp(
	String.raw`(?<![\p{L}\p{N}])(?:(от)\s*)?${NUMBER}(?:\s*(?:[-–—]|до)\s*${NUMBER})?|(?<![\p{L}\p{N}])до\s*${NUMBER}`,
	'giu'
);

const UNITS: Record<string, number> = { k: 1_000, к: 1_000, тыс: 1_000, 'тыс.': 1_000, млн: 1_000_000 };

function unitOf(suffix: string | undefined): number | null {
	if (suffix === undefined) return null;
	const unit = suffix.toLocaleLowerCase('ru');
	return unit.startsWith('тысяч') ? 1_000 : (UNITS[unit] ?? null);
}

/** The number as written, without its unit. */
const written = (whole: string, fraction: string | undefined) =>
	Number(`${whole.replace(/[ \u00a0\u202f]/gu, '')}.${fraction ?? '0'}`);

const amount = (whole: string, fraction: string | undefined, unit: number | null) =>
	Math.round(written(whole, fraction) * (unit ?? 1));

/** The smallest amount a range bound may be: «3–5 лет» and «2 раза в год» are not salaries. */
const MIN_AMOUNT = 1_000;
const MIN_HOURLY = 100;

interface SalaryFound {
	min: number | null;
	max: number | null;
	currency: string | null;
	period: 'month' | 'year' | 'hour' | null;
	taxBase: 'gross' | 'net' | 'unknown';
}

function boundsOf(match: RegExpMatchArray): { min: number | null; max: number | null } {
	const [
		,
		,
		firstWhole,
		firstFraction,
		firstSuffix,
		secondWhole,
		secondFraction,
		secondSuffix,
		upToWhole,
		upToFraction,
		upToSuffix
	] = match;
	if (upToWhole !== undefined) return { min: null, max: amount(upToWhole, upToFraction, unitOf(upToSuffix)) };
	if (firstWhole === undefined) return { min: null, max: null };
	const firstUnit = unitOf(firstSuffix);
	if (secondWhole === undefined) return { min: amount(firstWhole, firstFraction, firstUnit), max: null };
	const secondUnit = unitOf(secondSuffix);
	// A unit written once belongs to both ends: «120–160 тыс.» and «от 120 до 160 тыс.» are thousands at both ends. The
	// first end takes it only when, as written, it is not above the second number: «150 000 – 2 млн» is read as written.
	const sharedUnit =
		firstUnit === null && written(firstWhole, firstFraction) <= written(secondWhole, secondFraction)
			? secondUnit
			: null;
	return {
		min: amount(firstWhole, firstFraction, firstUnit ?? sharedUnit),
		max: amount(secondWhole, secondFraction, secondUnit)
	};
}

/** The first range of the line that reads as a salary: a currency or a word about pay, bounds of a plausible size. */
function salaryOf(line: string): SalaryFound | null {
	const currency = CURRENCIES.find(([, marker]) => marker.test(line))?.[0] ?? null;
	if (currency === null && !SALARY_WORD.test(line)) return null;
	const period = PERIODS.find(([, marker]) => marker.test(line))?.[0] ?? null;
	const taxBase = TAX_BASES.find(([, marker]) => marker.test(line))?.[0] ?? 'unknown';
	const least = period === 'hour' ? MIN_HOURLY : MIN_AMOUNT;
	for (const match of line.matchAll(RANGE)) {
		const { min, max } = boundsOf(match);
		if (min === null && max === null) continue;
		if ([min, max].some((bound) => bound !== null && bound < least)) continue;
		if (min !== null && max !== null && min > max) continue;
		return { min, max, currency, period, taxBase };
	}
	return null;
}

// --- Work terms and city ----------------------------------------------------------------------------------------------

const OFFICE = w('офис\\p{L}*|office|on-?site', 'i');
const REMOTE = w('удал[её]нн?\\p{L}*|удал[её]нк\\p{L}*|дистанц\\p{L}*|remote|из дома', 'i');
const HYBRID = w('гибрид\\p{L}*|hybrid', 'i');

function workFormatOf(line: string): string | null {
	if (HYBRID.test(line) || (OFFICE.test(line) && REMOTE.test(line))) return 'hybrid';
	if (REMOTE.test(line)) return 'remote';
	if (OFFICE.test(line)) return 'office';
	return null;
}

const EMPLOYMENT: readonly [string, RegExp][] = [
	['full', w('полн\\p{L}* (?:занятост\\p{L}*|рабоч\\p{L}* день|день)|full[- ]?time', 'i')],
	[
		'part',
		w('частичн\\p{L}* занятост\\p{L}*|неполн\\p{L}* (?:занятост\\p{L}*|рабоч\\p{L}* день|день)|part[- ]?time', 'i')
	],
	['internship', w('стажировк\\p{L}*|стаж[её]р\\p{L}*|internship', 'i')],
	[
		'project',
		w('проектн\\p{L}* (?:работ\\p{L}*|занятост\\p{L}*)|временн\\p{L}* (?:работ\\p{L}*|занятост\\p{L}*)', 'i')
	],
	['side_job', w('подработк\\p{L}*|совместительств\\p{L}*', 'i')]
];

const CONTRACTS: readonly [string, RegExp][] = [
	['labor', w('трудов\\p{L}* договор\\p{L}*|тк(?![\\p{L}])|в штат\\p{L}*', 'i')],
	['gph', w('гпх|гражданско-правов\\p{L}* договор\\p{L}*', 'i')],
	['self_employed', w('самозанят\\p{L}*|нпд(?![\\p{L}])', 'i')],
	['ip', w('ип(?![\\p{L}])', 'i')]
];
/** «ИП» names the form of a contract only next to words about the contract, not in a company name. */
const CONTRACT_CONTEXT = w('оформлен\\p{L}*|договор\\p{L}*|трудоустр\\p{L}*|сотрудничеств\\p{L}*|contract', 'i');

/** Cities named in vacancies of the market data; a city outside the list is read only after «Город:». */
const CITIES = [
	'Москва',
	'Санкт-Петербург',
	'Новосибирск',
	'Екатеринбург',
	'Казань',
	'Нижний Новгород',
	'Челябинск',
	'Самара',
	'Омск',
	'Ростов-на-Дону',
	'Красноярск',
	'Воронеж',
	'Пермь',
	'Волгоград',
	'Краснодар',
	'Саратов',
	'Тюмень',
	'Томск',
	'Иннополис',
	'Калининград',
	'Ярославль',
	'Ижевск',
	'Иркутск',
	'Владивосток',
	'Сочи'
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** A city in any case: «Москва» — «в Москве», «Пермь» — «в Перми», but not «Московская». */
const CITY_PATTERNS = CITIES.map((city) => ({
	city,
	pattern: w(
		city
			.split(' ')
			.map((word) => `${escape(word.replace(/[аяьй]$/u, ''))}\\p{L}{0,2}(?![\\p{L}])`)
			.join('\\s+'),
		'i'
	)
}));
const CITY_LABEL = /^(?:город|локация|location|местоположение|офис)\s*:\s*([\p{L}][\p{L} -]{1,40}?)(?=[,.;(]|$)/iu;
/** «г. Ташкент», «г.Казань». */
const CITY_ABBREVIATION = /(?<![\p{L}])г\.\s?(\p{Lu}[\p{L}-]+)/u;

function cityOf(line: string): string | null {
	const text = line.replace(/^[^\p{L}\p{N}]+/u, '');
	const labelled = CITY_LABEL.exec(text)?.[1]?.trim();
	if (labelled && !REMOTE.test(labelled)) {
		return CITY_PATTERNS.find(({ pattern }) => pattern.test(labelled))?.city ?? labelled;
	}
	return CITY_PATTERNS.find(({ pattern }) => pattern.test(text))?.city ?? CITY_ABBREVIATION.exec(text)?.[1] ?? null;
}

// --- The reader -------------------------------------------------------------------------------------------------------

const skillReaders = new WeakMap<VacancyTaxonomy, SkillReader>();

/** The aliases of the taxonomy in the shape the scanner of skill mentions reads them. */
function skillReader(taxonomy: VacancyTaxonomy): SkillReader {
	let reader = skillReaders.get(taxonomy);
	if (!reader) {
		reader = buildSkillReader(
			[...taxonomy.aliasesBySkill].flatMap(([skillKey, aliases]) =>
				aliases.map((aliasNormalized) => ({ aliasNormalized, skillKey }))
			)
		);
		skillReaders.set(taxonomy, reader);
	}
	return reader;
}

const located = (block: Block, quote: string) => ({ block_id: block.id, quote });

/**
 * Elements of a vacancy text by rules, in the shape of the `vacancy-extract/v2` answer. A line is a block
 * (`textBlocks`): the quote of an element is a part of its line.
 */
export function readVacancyByRules(blocks: readonly Block[], taxonomy: VacancyTaxonomy) {
	const title = findTitle(blocks, taxonomy);
	const grade = findGrade(blocks, title, taxonomy);
	const answer = {
		role_titles: title ? [{ raw_text: title.text, ...located(title.block, title.text) }] : [],
		grades: grade
			? [
					{
						raw_text: grade.text,
						grade_min: grade.range.min,
						grade_max: grade.range.max,
						...located(grade.block, grade.text)
					}
				]
			: [],
		required_skills: [] as { raw_text: string; polarity: 'asserted'; block_id: string; quote: string }[],
		nice_skills: [] as { raw_text: string; polarity: 'asserted'; block_id: string; quote: string }[],
		salaries: [] as {
			raw_text: string;
			salary_min: number;
			salary_max: number;
			currency: string;
			period: string;
			tax_base: string;
			block_id: string;
			quote: string;
		}[],
		work_formats: [] as { raw_text: string; value: string; block_id: string; quote: string }[],
		employment_forms: [] as { raw_text: string; value: string; block_id: string; quote: string }[],
		contract_types: [] as { raw_text: string; value: string; block_id: string; quote: string }[],
		cities: [] as { raw_text: string; block_id: string; quote: string }[]
	};

	const reader = skillReader(taxonomy);
	// The text before the first heading is read as requirements: the pasted vacancy is the employer's own.
	let section: Section = 'requirements';
	for (const block of blocks) {
		section = headingOf(block.text) ?? section;
		const line = block.text;

		if (section !== 'offer' && !HASHTAG_LINE.test(line) && !CONTACT_LINE.test(line)) {
			for (const span of skillSpans(line, reader, false)) {
				const nice = section === 'nice' || NICE_IN_LINE.test(clauseAt(line, span.start));
				(nice ? answer.nice_skills : answer.required_skills).push({
					raw_text: span.text,
					polarity: 'asserted',
					...located(block, span.text)
				});
			}
		}

		if (answer.salaries.length === 0) {
			const salary = salaryOf(line);
			if (salary) {
				answer.salaries.push({
					raw_text: line,
					salary_min: salary.min ?? 0,
					salary_max: salary.max ?? 0,
					currency: salary.currency ?? NOT_STATED,
					period: salary.period ?? NOT_STATED,
					tax_base: salary.taxBase,
					...located(block, line)
				});
			}
		}

		const format = workFormatOf(line);
		if (format !== null && answer.work_formats.length === 0 && taxonomy.terms.work_format.includes(format)) {
			answer.work_formats.push({ raw_text: line, value: format, ...located(block, line) });
		}
		const employment = EMPLOYMENT.find(([, pattern]) => pattern.test(line))?.[0];
		if (
			employment !== undefined &&
			answer.employment_forms.length === 0 &&
			taxonomy.terms.employment_form.includes(employment)
		) {
			answer.employment_forms.push({ raw_text: line, value: employment, ...located(block, line) });
		}
		for (const [contract, pattern] of CONTRACTS) {
			if (!pattern.test(line) || !taxonomy.terms.contract_type.includes(contract)) continue;
			if (contract === 'ip' && !CONTRACT_CONTEXT.test(line)) continue;
			if (answer.contract_types.some((element) => element.value === contract)) continue;
			answer.contract_types.push({ raw_text: line, value: contract, ...located(block, line) });
		}
		const city = answer.cities.length === 0 ? cityOf(line) : null;
		if (city !== null) answer.cities.push({ raw_text: city, ...located(block, line) });
	}
	return answer;
}

/** The rule elements after the checks every extracted element passes; what fails them is reported, never kept. */
export function extractVacancyByRules(
	blocks: readonly Block[],
	taxonomy: VacancyTaxonomy,
	lexicon: VacancyLexicon
): CheckedItems<VacancyItem> {
	return checkVacancyAnswer(readVacancyByRules(blocks, taxonomy), blocks, lexicon);
}
