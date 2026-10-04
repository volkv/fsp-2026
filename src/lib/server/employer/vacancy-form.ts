// The vacancy form of the cabinet (docs/domain.md, section 13.1): what the employer typed, turned into the input of
// `createOwnVacancy` / `updateOwnVacancy`. Skills are typed as names or aliases separated by commas and resolved by the
// taxonomy rules, the same as in pasted text; a name the taxonomy does not know is a field error, never dropped.
import type { OwnVacancyInput } from '$lib/server/vacancies/own';
import type { VacancyTextDraft } from '$lib/server/vacancies/from-text';
import { resolveSkill, type VacancyTaxonomy } from '$lib/server/vacancies/taxonomy';
import type { OwnVacancyView } from './vacancies';
import type { VacancyFormValues } from '$lib/components/employer/model';
import type { Labels } from './vocabulary';

export const EMPTY_VACANCY_FORM: VacancyFormValues = {
	title: '',
	description: '',
	roleKey: '',
	gradeMin: '',
	gradeMax: '',
	requiredSkills: '',
	niceSkills: '',
	workFormat: '',
	employmentForm: '',
	contractTypes: [],
	cityId: '',
	timezoneOverlapHours: '',
	minAge: '',
	salaryMin: '',
	salaryMax: '',
	currency: '',
	period: '',
	taxBase: ''
};

const text = (form: FormData, name: string) => {
	const value = form.get(name);
	return typeof value === 'string' ? value : '';
};

export function readVacancyForm(form: FormData): VacancyFormValues {
	return {
		title: text(form, 'title'),
		description: text(form, 'description'),
		roleKey: text(form, 'roleKey'),
		gradeMin: text(form, 'gradeMin'),
		gradeMax: text(form, 'gradeMax'),
		requiredSkills: text(form, 'requiredSkills'),
		niceSkills: text(form, 'niceSkills'),
		workFormat: text(form, 'workFormat'),
		employmentForm: text(form, 'employmentForm'),
		contractTypes: form.getAll('contractTypes').filter((value): value is string => typeof value === 'string'),
		cityId: text(form, 'cityId'),
		timezoneOverlapHours: text(form, 'timezoneOverlapHours'),
		minAge: text(form, 'minAge'),
		salaryMin: text(form, 'salaryMin'),
		salaryMax: text(form, 'salaryMax'),
		currency: text(form, 'currency'),
		period: text(form, 'period'),
		taxBase: text(form, 'taxBase')
	};
}

/** Skill keys of a comma-separated list: by key, by the taxonomy name, then by the alias rules. */
function skillKeys(raw: string, taxonomy: VacancyTaxonomy, labels: Labels): { keys: string[]; unknown: string[] } {
	const byName = new Map(Object.entries(labels.skills).map(([key, name]) => [name.toLowerCase(), key]));
	const keys: string[] = [];
	const unknown: string[] = [];
	for (const token of raw.split(/[,;\n]/u)) {
		const item = token.trim();
		if (item === '') continue;
		const lower = item.toLowerCase();
		const key =
			(taxonomy.aliasesBySkill.has(lower) ? lower : undefined) ?? byName.get(lower) ?? resolveSkill(taxonomy, item);
		if (key === null) unknown.push(item);
		else if (!keys.includes(key)) keys.push(key);
	}
	return { keys, unknown };
}

const INTEGER = /^\d+$/u;
const MIN_AGE_MESSAGE = 'Минимальный возраст — 14, 15, 16 лет или только совершеннолетние';
/** Ages a vacancy for minors may start from; an empty field — adults only. */
const MIN_AGES: Record<string, OwnVacancyInput['minAge']> = { '': null, '14': 14, '15': 15, '16': 16 };
const amount = (value: string) => value.replace(/\s/gu, '');

export type VacancyFormResult = { ok: true; input: OwnVacancyInput } | { ok: false; fields: Record<string, string> };

/**
 * The input of the vacancy services, or the problems of the fields that cannot be sent at all (unknown skills, numbers
 * that are not numbers). Everything else — lengths, keys, the range — is checked by the service itself.
 */
export function vacancyInput(values: VacancyFormValues, taxonomy: VacancyTaxonomy, labels: Labels): VacancyFormResult {
	const fields: Record<string, string> = {};
	const required = skillKeys(values.requiredSkills, taxonomy, labels);
	const nice = skillKeys(values.niceSkills, taxonomy, labels);
	if (required.unknown.length > 0) {
		fields.requiredSkillKeys = `Нет в справочнике навыков: ${required.unknown.join(', ')}`;
	}
	if (nice.unknown.length > 0) fields.niceSkillKeys = `Нет в справочнике навыков: ${nice.unknown.join(', ')}`;
	const salaryMin = amount(values.salaryMin);
	const salaryMax = amount(values.salaryMax);
	if (!INTEGER.test(salaryMin)) fields['salary.min'] = 'Нижняя граница вилки — целое число';
	if (!INTEGER.test(salaryMax)) fields['salary.max'] = 'Верхняя граница вилки — целое число';
	if (values.currency === '') fields['salary.currency'] = 'Укажите валюту вилки';
	if (!['month', 'year', 'hour', 'project'].includes(values.period)) fields['salary.period'] = 'Укажите период вилки';
	if (values.taxBase !== 'gross' && values.taxBase !== 'net') {
		fields['salary.taxBase'] = 'Укажите, до вычета НДФЛ вилка или на руки';
	}
	const overlap = values.timezoneOverlapHours.trim();
	if (overlap !== '' && !INTEGER.test(overlap)) fields.timezoneOverlapHours = 'Число часов от 0 до 24';
	const minAge = MIN_AGES[values.minAge];
	if (minAge === undefined) fields.minAge = MIN_AGE_MESSAGE;
	if (Object.keys(fields).length > 0 || minAge === undefined) return { ok: false, fields };
	return {
		ok: true,
		input: {
			title: values.title,
			description: values.description,
			roleKey: values.roleKey,
			gradeMin: values.gradeMin,
			gradeMax: values.gradeMax,
			requiredSkillKeys: required.keys,
			niceSkillKeys: nice.keys,
			workFormat: values.workFormat,
			employmentForm: values.employmentForm,
			contractTypes: values.contractTypes,
			cityId: values.cityId.trim() === '' ? null : values.cityId.trim(),
			timezoneOverlapHours: overlap === '' ? null : Number(overlap),
			minAge,
			salary: {
				min: Number(salaryMin),
				max: Number(salaryMax),
				currency: values.currency,
				period: values.period as OwnVacancyInput['salary']['period'],
				taxBase: values.taxBase as OwnVacancyInput['salary']['taxBase']
			}
		}
	};
}

const names = (keys: readonly string[], labels: Labels) => keys.map((key) => labels.skills[key] ?? key).join(', ');

/** The form of a stored vacancy, for its edit. */
export function vacancyFormOf(vacancy: OwnVacancyView, labels: Labels): VacancyFormValues {
	return {
		title: vacancy.title,
		description: vacancy.description,
		roleKey: vacancy.roleKey,
		gradeMin: vacancy.gradeMin,
		gradeMax: vacancy.gradeMax,
		requiredSkills: names(vacancy.requiredSkillKeys, labels),
		niceSkills: names(vacancy.niceSkillKeys, labels),
		workFormat: vacancy.workFormat,
		employmentForm: vacancy.employmentForm,
		contractTypes: vacancy.contractTypes,
		cityId: vacancy.cityId ?? '',
		timezoneOverlapHours: vacancy.timezoneOverlapHours === null ? '' : String(vacancy.timezoneOverlapHours),
		minAge: vacancy.minAge === null ? '' : String(vacancy.minAge),
		salaryMin: String(vacancy.salary.min),
		salaryMax: String(vacancy.salary.max),
		currency: vacancy.salary.currency,
		period: vacancy.salary.period,
		taxBase: vacancy.salary.taxBase
	};
}

/** Quotes of the pasted text behind each prefilled field: the employer sees where a value came from. */
export type DraftQuotes = Partial<Record<keyof VacancyFormValues, string[]>>;

/** The form prefilled from a pasted-text draft; a field the text does not state stays empty (`null`, not a guess). */
export function vacancyFormOfDraft(
	draft: VacancyTextDraft,
	text: string,
	labels: Labels
): { values: VacancyFormValues; quotes: DraftQuotes; unrecognizedSkills: string[]; negatedSkills: string[] } {
	const { fields } = draft;
	const known = (list: typeof fields.requiredSkills) =>
		list.flatMap((skill) => (skill.key === null ? [] : [skill.key]));
	const salary = fields.salary?.value;
	const quotes: DraftQuotes = {};
	const quote = (field: keyof VacancyFormValues, value: { quote: { text: string } } | null | undefined) => {
		if (value) (quotes[field] ??= []).push(value.quote.text);
	};
	quote('title', fields.title);
	quote('gradeMin', fields.grade);
	quote('workFormat', fields.workFormat);
	quote('employmentForm', fields.employmentForm);
	quote('cityId', fields.city);
	quote('salaryMin', fields.salary);
	for (const skill of fields.requiredSkills) quote('requiredSkills', skill.key === null ? null : skill);
	for (const skill of fields.niceSkills) quote('niceSkills', skill.key === null ? null : skill);
	for (const contract of fields.contractTypes) quote('contractTypes', contract);
	return {
		values: {
			...EMPTY_VACANCY_FORM,
			title: fields.title?.value ?? '',
			description: text,
			roleKey: fields.roleKey ?? '',
			gradeMin: fields.grade?.value.min ?? '',
			gradeMax: fields.grade?.value.max ?? '',
			requiredSkills: names(known(fields.requiredSkills), labels),
			niceSkills: names(known(fields.niceSkills), labels),
			workFormat: fields.workFormat?.value ?? '',
			employmentForm: fields.employmentForm?.value ?? '',
			contractTypes: fields.contractTypes.map((contract) => contract.value),
			cityId: fields.city?.value ?? '',
			salaryMin: salary?.min === null || salary === undefined ? '' : String(salary.min),
			salaryMax: salary?.max === null || salary === undefined ? '' : String(salary.max),
			currency: salary?.currency ?? '',
			period: salary?.period ?? '',
			taxBase: salary && salary.taxBase !== 'unknown' ? salary.taxBase : ''
		},
		quotes,
		unrecognizedSkills: [...fields.requiredSkills, ...fields.niceSkills]
			.filter((skill) => skill.key === null)
			.map((skill) => skill.raw),
		negatedSkills: fields.negatedSkills.map((skill) =>
			skill.key === null ? skill.raw : (labels.skills[skill.key] ?? skill.raw)
		)
	};
}

/** What the employer is told for a field the vacancy service refused; the service words its checks for developers. */
const FIELD_MESSAGES: Record<string, string> = {
	title: 'Название — от 3 до 200 символов',
	description: 'Описание — от 20 до 20 000 символов',
	roleKey: 'Выберите роль из справочника',
	gradeMin: 'Выберите грейд «от»',
	gradeMax: 'Грейд «до» не ниже грейда «от»',
	requiredSkillKeys: 'Обязательные навыки — до 30 из справочника',
	niceSkillKeys: 'Желательные навыки — до 30, без повторов обязательных',
	workFormat: 'Выберите формат работы',
	employmentForm: 'Выберите занятость',
	contractTypes: 'Отметьте хотя бы один тип договора',
	cityId: 'Город — до 100 символов',
	timezoneOverlapHours: 'Число часов от 0 до 24',
	minAge: MIN_AGE_MESSAGE,
	'salary.min': 'Нижняя граница — целое положительное число',
	'salary.max': 'Верхняя граница не ниже нижней',
	'salary.currency': 'Валюта — трёхбуквенный код',
	'salary.period': 'Укажите период вилки',
	'salary.taxBase': 'Укажите, до вычета НДФЛ вилка или на руки',
	salary: 'Для публикации нужна полная вилка: обе границы, валюта, период и налоговая база',
	'fromText.mlResultId': 'Разбор текста устарел — вставьте текст ещё раз'
};

/** Field problems of a refused post in the words of the form. */
export function vacancyFieldMessages(fields: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.keys(fields).map((path) => [path, FIELD_MESSAGES[path] ?? 'Проверьте это поле']));
}
