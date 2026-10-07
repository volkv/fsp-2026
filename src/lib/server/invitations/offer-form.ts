// The offer as the pages of the company write it (docs/domain.md, section 13.5): the points of «why you» the card of
// the candidate suggests — results of FSP by the receipts issued to the company, skills in the profile, the
// preferences the card shows — and the reading of the posted form into the input of the sending. The service checks
// every source again: a point the form names is not trusted for being on the page.
import { fspRecordText } from '$lib/components/employer/shortlist.js';
import { AWARDS, DISCIPLINES } from '$lib/components/product/model.js';
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { formText } from '$lib/server/http/form';
import { loadCompanyProfile } from '$lib/server/companies/public-profile';
import type { Executor } from '$lib/server/db';
import { searchableVacancies } from '$lib/server/employer/vacancies';
import type { CompanyNeedMatch } from '$lib/server/matching/search';
import type { Vocabulary } from '$lib/server/employer/vocabulary';
import type { NeedForm } from '$lib/server/needs/form';
import type { CandidateCard } from '$lib/server/visibility/projections';
import { currentPolicy } from './policies';
import type { OfferInput } from './send';
import { OFFER_WORK_FORMATS, type WhyYouPoint, type WhyYouSourceKind } from './terms';

/** A point the employer may pick, with the key the form posts it by. */
export interface WhyYouOption {
	key: string;
	text: string;
	source: WhyYouPoint['source'];
}

const keyOf = (source: WhyYouPoint['source']) =>
	[source.kind, source.ref, source.receipt_handle ?? ''].map(encodeURIComponent).join('|');

/** A point of «why you» the page offers, keyed by its source. */
export const pointOption = (text: string, source: WhyYouPoint['source']): WhyYouOption => ({
	key: keyOf(source),
	text,
	source
});

/** Points of an already sent version, offered again in its revision. */
export function optionsOfPoints(points: readonly WhyYouPoint[]): WhyYouOption[] {
	return points.map((point) => pointOption(point.text, point.source));
}

/**
 * Points the catalog card of the candidate supports: each FSP result the company holds a receipt for, each skill of the
 * profile, the work formats, the region and the readiness to relocate. Names come from the vocabularies of the page.
 */
export function whyYouOptions(
	card: CandidateCard,
	names: { skills: Readonly<Record<string, string>>; workFormats: Readonly<Record<string, string>> }
): WhyYouOption[] {
	const options: WhyYouOption[] = [];
	for (const achievement of card.fspAchievements ?? []) {
		const [handle] = achievement.receiptHandles;
		if (handle === undefined) continue;
		const { discipline, season, resultGroup } = achievement.generalized;
		const disciplineName =
			discipline === undefined
				? 'ФСП'
				: Object.hasOwn(DISCIPLINES, discipline)
					? DISCIPLINES[discipline as keyof typeof DISCIPLINES].name
					: discipline;
		const award = resultGroup === undefined ? null : AWARDS[resultGroup];
		const text = [`${disciplineName}${season === undefined ? '' : `, ${season}`}`, award].filter(Boolean).join(' — ');
		options.push(pointOption(`Результат ФСП: ${text}`, { kind: 'fsp_fact', ref: handle, receipt_handle: handle }));
	}
	for (const skill of card.skills ?? []) {
		const name = names.skills[skill.skillKey] ?? skill.skillKey;
		options.push(pointOption(`В профиле — ${name}`, { kind: 'declared_skill', ref: skill.skillKey }));
	}
	const preferences = card.preferences;
	if (preferences && preferences.workFormats.length > 0) {
		const formats = preferences.workFormats.map((key) => names.workFormats[key] ?? key).join(', ');
		options.push(pointOption(`Подходящий формат работы: ${formats}`, { kind: 'preference', ref: 'work_formats' }));
	}
	if (card.regionName) {
		options.push(pointOption(`Регион: ${card.regionName}`, { kind: 'preference', ref: 'region_code' }));
	}
	if (preferences?.relocation === true) {
		options.push(pointOption('Готов к переезду', { kind: 'preference', ref: 'relocation' }));
	}
	return options;
}

/** What a reason of a shortlist needs to be worded: names of skills, formats, blocks and categories. */
export interface ShortlistNames {
	skills: Readonly<Record<string, string>>;
	workFormats: Readonly<Record<string, string>>;
	specializations: Readonly<Record<string, string>>;
	grades: Readonly<Record<string, string>>;
}

/**
 * Points of «why you» from the reasons a shortlist gave for the candidate (domain 13.10): a block of the test by its
 * code, a claimed skill by its key, the work format; an FSP result and the FSP record by the receipts the card issued
 * to the company — the record by the first of them, every other result by its own. A
 * reason with no source an offer accepts (a public profile) gives no point. The strongest reasons come first.
 */
export function whyYouFromShortlist(
	match: CompanyNeedMatch,
	cardOptions: readonly WhyYouOption[],
	names: ShortlistNames
): WhyYouOption[] {
	const skill = (key: string) => names.skills[key] ?? key;
	const category = (specialization: string, grade: string) =>
		`${names.specializations[specialization] ?? specialization} ${names.grades[grade] ?? grade}`;
	const block = (code: string) => CATALOG.blocks.find((b) => b.code === code)?.title ?? code;
	const points: WhyYouOption[] = [];
	for (const reason of match.reasons) {
		const source = reason.source;
		switch (reason.code) {
			case 'skills_test':
				if (source.kind === 'test_block') {
					const text = `Тест подтвердил: ${reason.skill_keys.map(skill).join(', ')} — блок «${block(source.ref)}», ${category(source.specialization, source.grade)}`;
					points.push(pointOption(text, { kind: 'test_block', ref: source.ref }));
				}
				break;
			case 'test_result':
				if (source.kind === 'test_block') {
					const text = `Категория ${category(source.specialization, source.grade)} подтверждена тестом; сильнее всего — блок «${block(source.ref)}»`;
					points.push(pointOption(text, { kind: 'test_block', ref: source.ref }));
				}
				break;
			case 'confirmed_recently':
				if (source.kind === 'test_block') {
					const text = `Категория ${category(source.specialization, source.grade)} подтверждена тестом ${reason.days} дн. назад`;
					points.push(pointOption(text, { kind: 'test_block', ref: source.ref }));
				}
				break;
			case 'skills_fsp':
				points.push(...cardOptions.filter((card) => card.source.kind === 'fsp_fact'));
				break;
			case 'fsp_record': {
				// The record as the shortlist counted it, named by a receipt of the card; each result keeps its own point.
				const results = cardOptions.filter((card) => card.source.kind === 'fsp_fact');
				const [first] = results;
				if (first !== undefined) {
					points.push(pointOption(`Результаты ФСП: ${fspRecordText(reason)}`, first.source), ...results.slice(1));
				}
				break;
			}
			case 'skills_claimed':
			case 'skills_claimed_untestable': {
				const [first] = reason.skill_keys;
				if (first !== undefined) {
					points.push(pointOption(`В профиле — ${skill(first)} (заявлено)`, { kind: 'declared_skill', ref: first }));
				}
				break;
			}
			case 'format_fits':
				points.push(
					pointOption(`Подходящий формат работы: ${names.workFormats[reason.format] ?? reason.format}`, {
						kind: 'preference',
						ref: 'work_formats'
					})
				);
				break;
			case 'skills_platform':
			case 'skills_public_profile':
				break;
		}
	}
	const seen = new Set<string>();
	return points.filter((point) => !seen.has(point.key) && seen.add(point.key));
}

const KINDS: readonly WhyYouSourceKind[] = [
	'test_block',
	'fsp_fact',
	'confirmation',
	'challenge_solution',
	'declared_skill',
	'preference'
];

/** The source a posted key names; a key of another shape is not a point. */
function sourceOfKey(key: string): WhyYouPoint['source'] | null {
	const [kind, ref, handle] = key.split('|').map(decodeURIComponent);
	const known = KINDS.find((candidate) => candidate === kind);
	if (!known || ref === undefined || ref === '') return null;
	return { kind: known, ref, ...(handle ? { receipt_handle: handle } : {}) };
}

const amount = (value: string) => Number(value.replace(/\s/gu, ''));

/**
 * The posted offer form: the terms, the picked points of «why you» with the texts the employer edited, and the vacancy
 * when one is picked. Validation is the sending's: an empty field reaches it as empty.
 */
export function offerFromForm(form: FormData): OfferInput {
	const whyYou = form
		.getAll('whyYou')
		.filter((value): value is string => typeof value === 'string')
		.flatMap((key) => {
			const source = sourceOfKey(key);
			return source ? [{ text: formText(form, `whyYouText:${key}`), source }] : [];
		});
	const note = formText(form, 'contactNote');
	const vacancyId = formText(form, 'vacancyId');
	return {
		title: formText(form, 'title'),
		description: formText(form, 'description'),
		salaryMin: amount(formText(form, 'salaryMin')),
		salaryMax: amount(formText(form, 'salaryMax')),
		salaryCurrency: 'RUB',
		salaryTaxBase: formText(form, 'salaryTaxBase'),
		workFormat: formText(form, 'workFormat'),
		contactMethod: { kind: formText(form, 'contactKind'), value: formText(form, 'contactValue'), note },
		whyYou,
		vacancyId: vacancyId === '' ? null : vacancyId,
		message: formText(form, 'message')
	};
}

/** The terms of the need an offer from its shortlist starts with; the employer may change each of them. */
export interface OfferNeedTerms {
	workFormat: NonNullable<NeedForm['work_format']> | null;
	salary: { min: number; max: number; taxBase: 'gross' | 'net' } | null;
}

/**
 * The work format and the range of the form of a shortlist step: the same the reasons of the shortlist are worded by,
 * so «why you» and the terms of the offer do not disagree.
 */
export function offerTermsOfNeed(form: NeedForm): OfferNeedTerms {
	return {
		workFormat: form.work_format ?? null,
		salary: form.salary ? { min: form.salary.min, max: form.salary.max, taxBase: form.salary.tax_base } : null
	};
}

/** What an offer form of the company needs besides the candidate: vacancies to name, formats, the policy, the profile. */
export interface OfferFormContext {
	vacancies: { id: string; title: string }[];
	workFormats: { key: string; name: string }[];
	responseWindowHours: number | null;
	/** The profile of the company is filled in; without it an offer is refused (`company_profile_incomplete`). */
	profileComplete: boolean;
}

export async function offerFormContext(
	executor: Executor,
	companyId: string,
	vocabulary: Vocabulary,
	now: Date
): Promise<OfferFormContext> {
	const [vacancies, policy, profile] = await Promise.all([
		searchableVacancies(executor, companyId),
		currentPolicy(executor, 'invitation_policy', now),
		loadCompanyProfile(executor, companyId)
	]);
	const names = new Map(vocabulary.terms.work_format.map(({ key, name }) => [key, name]));
	return {
		vacancies: vacancies.filter((v) => v.status === 'published').map(({ id, title }) => ({ id, title })),
		workFormats: OFFER_WORK_FORMATS.map((key) => ({ key, name: names.get(key) ?? key })),
		responseWindowHours: policy?.params.response_window_hours ?? null,
		profileComplete: profile.complete
	};
}
