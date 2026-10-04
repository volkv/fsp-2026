// Check of vacancy texts for discriminatory requirements (CONCEPT, promise 8; docs/domain.md, section 13.1): a
// dictionary of rules, each with its category, severity and an explanation the employer sees. `block` — a requirement
// the law does not allow to state as a condition of hiring (sex, age, marital status, nationality, appearance);
// the vacancy goes to an operator instead of being published, because some of them may be lawful (citizenship for a
// state secret clearance). `warning` — a phrasing that often hides such a requirement; the employer confirms it
// consciously. The same check runs on external vacancies: a blocked one is hidden.
import { z } from 'zod';
import { codePointLength, codePointToUtf16, utf16ToCodePoint } from '$lib/text/offsets';

export const TEXT_CHECK_VERSION = 'text-check/3';

export type TextCheckCategory = 'sex' | 'age' | 'citizenship' | 'marital_status' | 'nationality' | 'appearance';
export type TextCheckSeverity = 'block' | 'warning';

/** A match in its clause: the clause text before and after it, up to the nearest sentence or list boundary. */
interface Near {
	text: string;
	lead: string;
	tail: string;
}

interface TextRule {
	id: string;
	category: TextCheckCategory;
	severity: TextCheckSeverity;
	pattern: RegExp;
	/** Whether a match, by the words next to it, is a requirement to the candidate; absent — every match is. */
	applies?: (near: Near) => boolean;
	explanation: string;
}

const w = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'giu');

/** The part of the lead after the last comma, colon, semicolon or bracket: the member of the sentence the match is in. */
const segmentLead = (lead: string) => /[^,;:(]*$/u.exec(lead)?.[0] ?? '';
const segmentTail = (tail: string) => /^[^,;:()]*/u.exec(tail)?.[0] ?? '';
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
const lastWords = (text: string, count: number) => words(text).slice(-count);
const firstWords = (text: string, count: number) => words(text).slice(0, count);

/**
 * «Не важно», «независимо от», «любой» right next to the match: a statement that the property does not matter, not a
 * requirement. Only the member of the sentence the match is in counts — «Женат, любой опыт» is still a requirement.
 */
const NOT_IMPORTANT_BEFORE =
	/(?:независимо|зависимости) от$|без (?:учета|учёта|различи[яй]|требовани\p{L}*|ограничени\p{L}*)(?: (?:по|к))?$/u;
const NOT_IMPORTANT_AFTER =
	/^(?:\p{L}+ ){0,2}(?:не важ|неваж|не имеет значени|не имеют значени|значени\p{L}* не име|любо\p{L}*|не обязательн|необязательн|не требуе|не требуют)/u;

function notImportant(near: Near): boolean {
	return (
		NOT_IMPORTANT_BEFORE.test(lastWords(segmentLead(near.lead), 3).join(' ')) ||
		NOT_IMPORTANT_AFTER.test(firstWords(segmentTail(near.tail), 5).join(' '))
	);
}

const MALE_PERSON =
	'мужчин\\p{L}{0,3}|парн(?:я|ю|ем|е|и|ей|ям|ями|ях)|парень|юнош(?:а|и|у|ей|е|ам|ами|ах)|молод(?:ой|ого|ому|ым) человек\\p{L}{0,2}';
const FEMALE_PERSON = 'женщин\\p{L}{0,3}|девуш(?:ка|ки|ку|кой|ке|ек|кам|ками|ках)';
/** The sex named with «пол», on either side of it: «пол мужской», «мужской пол», «женского пола», «пола женского». */
const SEX_ADJECTIVE = '(?:мужско(?:й|го)|женск(?:ий|ого))';
/** Either sex named by a person or an adjective: «мужчин и женщин», «мужского или женского пола». */
const MALE = `${MALE_PERSON}|мужск\\p{L}{2,3}`;
const FEMALE = `${FEMALE_PERSON}|женск\\p{L}{2,3}`;
const COORDINATION = '\\s*(?:,\\s*)?(?:(?:и|или|либо|так и)\\s+|\\/\\s*|,\\s*)';
const pairBefore = (other: string) => new RegExp(`(?:${other})${COORDINATION}$`, 'iu');
const pairAfter = (other: string) => new RegExp(`^${COORDINATION}(?:(?:и|или)\\s+)?(?:\\p{L}+\\s+)?(?:${other})`, 'iu');
const PAIRED_WITH_FEMALE = [pairBefore(FEMALE), pairAfter(FEMALE)] as const;
const PAIRED_WITH_MALE = [pairBefore(MALE), pairAfter(MALE)] as const;

/** Words after which a person named by sex is the one sought: «ищем девушку», «нужен мужчина», «только парни». */
const SOUGHT =
	/^(?:ищ(?:ем|ет|ут|у)|требу(?:ется|ются|ем)|нуж(?:ен|на|ны|но)|пригла(?:шаем|шается|шаются|сим)|рассматрива(?:ем|ется|ются)|рассмотрим|возьм(?:ем|ём|у)|прим(?:ем|ём|у)|принимаем|подбира(?:ем|ю)|набира(?:ем|ю)|только|исключительно|лишь|предпочтительно|преимущественно|желательно|обязательно|быть|являться|приветству\p{L}*)$/u;
/** A person after a preposition is not the one sought: «команда из мужчин и женщин», «товары для женщин». */
const PREPOSITION = /^(?:для|из|среди|у|о|об|про|с|со|к|ко|по|между|от|над|при|без|на|в|во|за|перед)$/u;
/** …unless it is the position itself that is «для» them: «вакансия для мужчин», «работа для девушек». */
const POSITION = /^(?:ваканси[яию]|работ[аыу]|подработк[аиу]|должност[ьи]|позици[яию]|мест[оа])$/u;
/** A refusal right after the persons or the age: «женщин не рассматриваем», «35+ не берём». */
const REFUSED =
	'не (?:рассматрива(?:ем|ется|ются)|рассмотрим|бер[её]м|берут|возьм[её]м|принима(?:ем|ется|ются)|приглаша(?:ем|ется|ются))';
const REFUSED_AFTER = new RegExp(`^\\s*[—–-]?\\s*${REFUSED}(?![\\p{L}\\p{N}])`, 'iu');
/** What follows a person named at the start of a list item or a member: «Мужчина, опыт от года», «Женщина-аналитик». */
const ITEM_TAIL = /^(?:\s*$|\s*[,;(]|-\p{L}|\s+(?:от|до|не старше|не моложе|старше|моложе|без|с опытом|\d))/u;

function sexRequirement(near: Near): boolean {
	const male = /мужч|мужск|парн|парен|юнош|молод/iu.test(near.text);
	const paired = male ? PAIRED_WITH_FEMALE : PAIRED_WITH_MALE;
	if (paired[0].test(near.lead) || paired[1].test(near.tail)) return false;
	if (/^(?:только|исключительно|лишь) /iu.test(near.text) || /(?<!\p{L})пола?(?!\p{L})/iu.test(near.text)) return true;
	if (REFUSED_AFTER.test(segmentTail(near.tail))) return true;
	const lead = segmentLead(near.lead);
	const [before, previous] = lastWords(lead, 2).reverse();
	if (before !== undefined && PREPOSITION.test(before)) {
		return previous !== undefined && (SOUGHT.test(previous) || (before === 'для' && POSITION.test(previous)));
	}
	if (lastWords(lead, 3).some((word) => SOUGHT.test(word))) return true;
	return words(lead).length === 0 && ITEM_TAIL.test(near.tail);
}

/**
 * Feminine forms of positions. Sought — «ищем сотрудницу», «требуется бухгалтерша» — they read as a requirement to the
 * sex; in a text about the team («наша сотрудница расскажет») they are not, so only the sought one is a warning.
 */
const FEMININE_TITLE =
	'сотрудниц|бухгалтерш|администраторш|секретарш|менеджерш|директорш|продавщиц|помощниц|ассистентк|разработчиц|программистк|тестировщиц|аналитичк|дизайнерш|специалистк|кассирш|уборщиц|переводчиц|руководительниц|операторш|кадровичк|референтк';

function genderedTitleSought(near: Near): boolean {
	// «сотрудника или сотрудницу», «бухгалтера/бухгалтершу», «сотрудницу (сотрудника)»: both forms, no preference.
	if (/(?:[\s,](?:и|или|либо)|\/)\s*$/iu.test(near.lead) || /^\s*(?:\/|\(|,?\s*(?:или|либо)\s)/iu.test(near.tail)) {
		return false;
	}
	return lastWords(segmentLead(near.lead), 3).some((word) => SOUGHT.test(word));
}

/** A bare number of years next to «опыт», «стаж», «на рынке» is about experience or the company, not about age. */
const NOT_AGE_BEFORE =
	/^(?:опыт\p{L}*|стаж\p{L}*|рынке|компани\p{L}*|существу\p{L}*|работаем|ипотек\p{L}*|гаранти\p{L}*)$/u;
const NOT_AGE_AFTER = /^(?:\p{L}+ )?(?:опыт|стаж|работы|на рынке|в (?:ит|it|разработк|отрасл|индустри|профессии))/u;

function ageRequirement(near: Near): boolean {
	if (/возраст|ценз|г\.|рождени/iu.test(near.text)) return true;
	return !(
		lastWords(segmentLead(near.lead), 4).some((word) => NOT_AGE_BEFORE.test(word)) ||
		NOT_AGE_AFTER.test(firstWords(near.tail, 4).join(' '))
	);
}

/** Years of age in digits («35», «35-ти») or in words, tens from twenty to sixty («тридцати», «сорока пяти»). */
const AGE_WORD =
	'(?:двадцат[иь]|тридцат[иь]|сорока?|пятидесяти|пятьдесят|шестидесяти|шестьдесят)(?:\\s+(?:одного|один|двух|два|тр[её]х|три|четыр[её]х|четыре|пяти|пять|шести|шесть|семи|семь|восьми|восемь|девяти|девять))?';
const YEARS = `(?:\\d{2}(?:-?(?:ти|и|х|ми))?|${AGE_WORD})`;
const AGE_UNIT = '(?:\\s*(?:лет|года?))';
/** Without «возраст» next to it only «лет» names an age: «до 27 года» is also a year. */
const AGE_YEARS = '(?:\\s*лет)';
const AGE_NUMBER = `${YEARS}(?:\\+|\\s*(?:[-–—]|до)\\s*${YEARS})?${AGE_UNIT}?`;
/**
 * A bare «до 30» names an age only right after a person and at the end of the member of the sentence: «студентов до
 * 25», «молодой специалист до 30», but not «до 35 000 ₽», «до 30 человек» or «до 30 числа».
 */
const AGE_PERSON =
	'(?:специалист|студент|выпускник|кандидат|соискател|сотрудни|стаж[её]р|девуш|юнош|парн|мужчин|женщин)\\p{L}*';
const MEMBER_END = '(?=\\s*(?:$|[,;:!?)\\n]|\\.(?!\\d)))';

export const TEXT_RULES: readonly TextRule[] = [
	{
		id: 'sex.explicit',
		category: 'sex',
		severity: 'block',
		pattern: w(
			`пола?\\s*[:—–-]?\\s*${SEX_ADJECTIVE}|${SEX_ADJECTIVE} пола?|(?:(?:только|исключительно|лишь) )?(?:${MALE_PERSON}|${FEMALE_PERSON})`
		),
		applies: sexRequirement,
		explanation:
			'Требование к полу кандидата не допускается (ст. 3, 64 ТК РФ; ч. 6 ст. 25 закона «О занятости населения»).'
	},
	{
		id: 'age.limit',
		category: 'age',
		severity: 'block',
		pattern: w(
			[
				`(?:(?:в )?возраст(?:е|ом|а)?(?: кандидата| соискателя)?|возрастн\\p{L}* (?:ценз|ограничени|рамк|предел|границ)\\p{L}*|ценз)\\s*[:—–-]?\\s*(?:(?:от|до|не (?:старше|моложе|более|менее|выше|ниже))\\s*)?${AGE_NUMBER}`,
				'(?:не ранее |не позднее |не старше |не моложе )?\\d{4}\\s*(?:г\\.\\s?р\\.?|года рождения)',
				`(?:(?:после|старше) ${YEARS}\\+?${AGE_UNIT}?|\\d{2}\\+|${YEARS}${AGE_YEARS})\\s*[—–-]?\\s*${REFUSED}`,
				`(?:не старше|не моложе|моложе|старше) ${YEARS}${AGE_UNIT}?`,
				`до ${YEARS}${AGE_YEARS}`,
				`(?<=${AGE_PERSON}\\s+)до \\d{2}(?:-?(?:ти|и|х))?${MEMBER_END}`,
				`от ${YEARS} до ${YEARS}${AGE_YEARS}`,
				`\\d{2} ?[-–—] ?\\d{2}${AGE_YEARS}`
			].join('|')
		),
		applies: ageRequirement,
		explanation:
			'Ограничение по возрасту не допускается (ст. 3, 64 ТК РФ; ч. 6 ст. 25 закона «О занятости населения»). Опыт работы указывайте в годах опыта.'
	},
	{
		id: 'age.youth',
		category: 'age',
		severity: 'warning',
		pattern: w(
			'молод(?:ой|ая|ую|ого|ом|ые|ых|ым|ыми)(?: и)?(?: дружн\\p{L}*)? (?:коллектив\\p{L}*|команд\\p{L}*|специалист\\p{L}*)'
		),
		explanation:
			'Формулировка может читаться как предпочтение по возрасту. Опишите команду иначе, если возраст не требование.'
	},
	{
		id: 'sex.gendered_title',
		category: 'sex',
		severity: 'warning',
		pattern: w(`(?:${FEMININE_TITLE})\\p{L}{0,3}`),
		applies: genderedTitleSought,
		explanation:
			'Женская форма должности в объявлении о поиске читается как требование к полу. Если пол не требование, назовите должность нейтрально.'
	},
	{
		id: 'citizenship.required',
		category: 'citizenship',
		severity: 'block',
		pattern: w(
			'гражданств\\p{L}*:? ?(?:рф|россии|российской федерации)|российск\\p{L}* гражданств\\p{L}*|(?:только )?граждан(?:е|ин|ам)? (?:рф|россии|российской федерации)|наличие гражданства'
		),
		applies: (near) => !notImportant(near),
		explanation:
			'Требование гражданства допустимо только в случаях, установленных законом (например, допуск к гостайне). Вакансия уйдёт на проверку оператору.'
	},
	{
		id: 'marital.status',
		category: 'marital_status',
		severity: 'block',
		pattern: w(
			'замужем|замужн\\p{L}*|женат(?:ый|ые|ых|ого)?|холост\\p{L}*|незамужн\\p{L}*|семейн\\p{L}* положени\\p{L}*|без детей|(?:наличи|отсутстви)\\p{L}* детей|не планиру\\p{L}* (?:декрет\\p{L}*|детей|беременност\\p{L}*|пополнени\\p{L}*)'
		),
		applies: (near) => !notImportant(near),
		explanation: 'Требование к семейному положению и наличию детей не допускается (ст. 3, 64 ТК РФ).'
	},
	{
		id: 'nationality.explicit',
		category: 'nationality',
		severity: 'block',
		pattern: w(
			'национальност\\p{L}*|(?:славянск|европейск|кавказск|азиатск|восточн)\\p{L}* внешност\\p{L}*|славян(?:е|ин|ка)|славянск\\p{L}* происхождени\\p{L}*|русск(?:ий|ая) по национальности'
		),
		applies: (near) => !notImportant(near),
		explanation: 'Требование к национальности и происхождению не допускается (ст. 3, 64 ТК РФ).'
	},
	{
		id: 'appearance.explicit',
		category: 'appearance',
		severity: 'warning',
		pattern: w(
			'приятн\\p{L}* внешност\\p{L}*|презентабельн\\p{L}* внешност\\p{L}*|внешние данные|рост\\p{L}* (?:от|не ниже|не менее|выше) \\d{3}|(?:резюме|отклик\\p{L}*) с фото\\p{L}*|(?:приложите|прикрепите|пришлите) (?:ваше |свое |своё )?фото\\p{L}*'
		),
		explanation:
			'Требование к внешности не связано с деловыми качествами ИТ-специалиста и может быть дискриминационным.'
	}
];

export interface TextCheckPhrase {
	rule: string;
	category: TextCheckCategory;
	severity: TextCheckSeverity;
	/** Which text of the vacancy: `title`, `description`. */
	field: string;
	/** Code points within the field. */
	start: number;
	end: number;
	text: string;
	explanation: string;
}

/** What the FSP operator decided on a blocked text: publish it as lawful, return it for editing, or reject it. */
export type ModerationOutcome = 'published' | 'returned' | 'rejected';

/**
 * The case of an own vacancy with the operator (domain 13.1): opened when a blocked text sends the vacancy to
 * moderation, it carries where the vacancy returns and the operator's decision with its reason, which the employer reads.
 * An approval stays with the vacancy while its blocking findings stay the same.
 */
export interface TextCheckModeration {
	opened_at: string;
	/** Where the vacancy goes when the text is approved or cleared: `paused` for one paused before the edit. */
	resume_to: 'published' | 'paused';
	decision: { outcome: ModerationOutcome; reason: string | null; at: string } | null;
}

export interface TextCheck {
	validator_version: string;
	result: 'clean' | 'warnings' | 'blocked';
	phrases: TextCheckPhrase[];
	/** The employer confirmed the warnings: who and when. */
	warnings_confirmed: { member_id: string; at: string } | null;
	/** The operator's case of an own vacancy; `null` — the text never went to moderation or left it. */
	moderation: TextCheckModeration | null;
}

export const moderationSchema: z.ZodType<TextCheckModeration> = z.object({
	opened_at: z.iso.datetime(),
	resume_to: z.enum(['published', 'paused']),
	decision: z
		.object({
			outcome: z.enum(['published', 'returned', 'rejected']),
			reason: z.string().nullable(),
			at: z.iso.datetime()
		})
		.nullable()
});

export const textCheckSchema: z.ZodType<TextCheck> = z.object({
	validator_version: z.string(),
	result: z.enum(['clean', 'warnings', 'blocked']),
	phrases: z.array(
		z.object({
			rule: z.string(),
			category: z.enum(['sex', 'age', 'citizenship', 'marital_status', 'nationality', 'appearance']),
			severity: z.enum(['block', 'warning']),
			field: z.string(),
			start: z.int().nonnegative(),
			end: z.int().nonnegative(),
			text: z.string(),
			explanation: z.string()
		})
	),
	warnings_confirmed: z.object({ member_id: z.string(), at: z.string() }).nullable(),
	moderation: moderationSchema.nullable()
});

/** The clause around a match: up to the nearest sentence or list boundary on each side. */
function clauseAround(text: string, start: number, end: number): [number, number] {
	const boundary = /[.!?;\n•]/u;
	let from = start;
	while (from > 0 && !boundary.test(text.charAt(from - 1))) from--;
	let to = end;
	while (to < text.length && !boundary.test(text.charAt(to))) to++;
	return [from, to];
}

/** Checks the texts of a vacancy; each key of `fields` is a field name, `null` values are skipped. */
export function checkVacancyText(fields: Record<string, string | null>): TextCheck {
	const phrases: TextCheckPhrase[] = [];
	for (const [field, value] of Object.entries(fields)) {
		if (value === null || value === '') continue;
		for (const rule of TEXT_RULES) {
			for (const match of value.matchAll(rule.pattern)) {
				const start = match.index;
				const end = start + match[0].length;
				const [from, to] = clauseAround(value, start, end);
				const near = { text: match[0], lead: value.slice(from, start), tail: value.slice(end, to) };
				if (rule.applies !== undefined && !rule.applies(near)) continue;
				phrases.push({
					rule: rule.id,
					category: rule.category,
					severity: rule.severity,
					field,
					start: utf16ToCodePoint(value, start),
					end: utf16ToCodePoint(value, end),
					text: match[0],
					explanation: rule.explanation
				});
			}
		}
	}
	const result = phrases.some((p) => p.severity === 'block') ? 'blocked' : phrases.length > 0 ? 'warnings' : 'clean';
	return { validator_version: TEXT_CHECK_VERSION, result, phrases, warnings_confirmed: null, moderation: null };
}

const findingsKey = (check: TextCheck, severity?: TextCheckSeverity) =>
	check.phrases
		.filter((p) => severity === undefined || p.severity === severity)
		.map((p) => `${p.field}:${p.rule}:${p.text.toLowerCase()}`)
		.sort()
		.join('|');

/** The phrases of two checks are the same findings: a confirmation of warnings survives an edit that keeps them. */
export function sameFindings(a: TextCheck, b: TextCheck): boolean {
	return a.validator_version === b.validator_version && findingsKey(a) === findingsKey(b);
}

/** The blocking phrases of two checks are the same: the operator's approval survives an edit that keeps them. */
export function sameBlockingFindings(a: TextCheck, b: TextCheck): boolean {
	return a.validator_version === b.validator_version && findingsKey(a, 'block') === findingsKey(b, 'block');
}

/** A phrase in its surroundings, for the operator: up to `radius` code points of the field on each side. */
export interface PhraseQuote {
	before: string;
	text: string;
	after: string;
}

export function quoteOf(value: string, phrase: Pick<TextCheckPhrase, 'start' | 'end'>, radius = 80): PhraseQuote {
	const start = codePointToUtf16(value, phrase.start);
	const end = codePointToUtf16(value, phrase.end);
	const from = codePointToUtf16(value, Math.max(0, phrase.start - radius));
	const tail = value.slice(end);
	const to = end + codePointToUtf16(tail, Math.min(radius, codePointLength(tail)));
	return {
		before: `${from > 0 ? '…' : ''}${value.slice(from, start)}`,
		text: value.slice(start, end),
		after: `${value.slice(end, to)}${to < value.length ? '…' : ''}`
	};
}
