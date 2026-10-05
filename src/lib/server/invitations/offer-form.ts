// The offer as the pages of the company write it (docs/domain.md, section 13.5): the points of «why you» the card of
// the candidate suggests — results of FSP by the receipts issued to the company, skills in the profile, the
// preferences the card shows — and the reading of the posted form into the input of the sending. The service checks
// every source again: a point the form names is not trusted for being on the page.
import { AWARDS, DISCIPLINES } from '$lib/components/product/model.js';
import { formText } from '$lib/server/auth/http';
import { loadCompanyProfile } from '$lib/server/companies/public-profile';
import type { Executor } from '$lib/server/db';
import { searchableVacancies } from '$lib/server/employer/vacancies';
import type { Vocabulary } from '$lib/server/employer/vocabulary';
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

const option = (text: string, source: WhyYouPoint['source']): WhyYouOption => ({ key: keyOf(source), text, source });

/** Points of an already sent version, offered again in its revision. */
export function optionsOfPoints(points: readonly WhyYouPoint[]): WhyYouOption[] {
	return points.map((point) => option(point.text, point.source));
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
		options.push(option(`Результат ФСП: ${text}`, { kind: 'fsp_fact', ref: handle, receipt_handle: handle }));
	}
	for (const skill of card.skills ?? []) {
		const name = names.skills[skill.skillKey] ?? skill.skillKey;
		options.push(option(`В профиле — ${name}`, { kind: 'declared_skill', ref: skill.skillKey }));
	}
	const preferences = card.preferences;
	if (preferences && preferences.workFormats.length > 0) {
		const formats = preferences.workFormats.map((key) => names.workFormats[key] ?? key).join(', ');
		options.push(option(`Подходящий формат работы: ${formats}`, { kind: 'preference', ref: 'work_formats' }));
	}
	if (card.regionName) {
		options.push(option(`Регион: ${card.regionName}`, { kind: 'preference', ref: 'region_code' }));
	}
	if (preferences?.relocation === true) {
		options.push(option('Готов к переезду', { kind: 'preference', ref: 'relocation' }));
	}
	return options;
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
