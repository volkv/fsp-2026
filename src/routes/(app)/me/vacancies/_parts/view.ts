// What the vacancy search shows: the cards of the page already worded for the candidate, the search of the address
// and the options of its filters.
import { candidateMatchView, type MatchResultData } from '$lib/components/candidate/match.js';
import { gradeName, skillName, type Labels } from '$lib/components/candidate/model.js';
import {
	MATCH_COMPONENTS,
	SALARY_PERIODS,
	type MatchComponentKey,
	type MatchView
} from '$lib/components/product/model.js';
import type { PageData } from '../$types';

type Item = PageData['page']['items'][number];

export interface SkillView {
	key: string;
	name: string;
	required: boolean;
	/** `true` — confirmed for the candidate, `false` — missing, `null` — not known. */
	have: boolean | null;
}

export interface ComponentView {
	key: MatchComponentKey;
	label: string;
	/** 0..1, `null` when not computed. */
	value: number | null;
	weight: number;
}

export interface VacancyCard {
	id: string;
	href: string;
	title: string;
	company: string;
	verified: boolean;
	/** 0..1. */
	score: number;
	/** «87 %». */
	percent: string;
	/** «200 000 – 280 000 ₽», `null` when not stated. */
	salaryText: string | null;
	/** «в месяц». */
	salaryPeriod: string | null;
	salaryMin: number | null;
	salaryMax: number | null;
	grade: string;
	format: string;
	skills: SkillView[];
	/** Names of the required skills the candidate lacks. */
	missing: string[];
	/** Things to check at the interview. */
	toVerify: number;
	components: ComponentView[];
	invitation: { href: string; status: NonNullable<Item['invitation']>['status'] } | null;
	/** The full explanation for `<MatchBreakdown match={…} />`. */
	match: MatchView;
}

export interface SearchView {
	text: string;
	roleKey: string | null;
	gradeKey: string | null;
	workFormats: string[];
	filtered: boolean;
	roleOptions: [string, string][];
	gradeOptions: [string, string][];
	formatOptions: [string, string][];
	/** The address of the first page of the same search, when the page is not the first. */
	firstHref: string | null;
	/** The address of the next page, when there is one. */
	nextHref: string | null;
	/** The address without filters. */
	resetHref: string;
}

export interface VacanciesView {
	cards: VacancyCard[];
	search: SearchView;
	/** Semantic search is off: the list is ranked by words only. */
	degraded: boolean;
	/** Links of the header. */
	applicationsHref: string;
	profileHref: string;
}

const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });

/** «200 000 – 280 000 ₽», «от 150 000 ₽»; `null` when the range is not stated. */
export function salaryText(salary: { min: number | null; max: number | null; currency: string | null }): string | null {
	const { min, max, currency } = salary;
	const format = new Intl.NumberFormat('ru-RU', {
		style: 'currency',
		currency: currency ?? 'RUB',
		maximumFractionDigits: 0
	});
	if (min !== null && max !== null) return min === max ? format.format(min) : format.formatRange(min, max);
	if (min !== null) return `от ${format.format(min)}`;
	if (max !== null) return `до ${format.format(max)}`;
	return null;
}

/** The skills of a vacancy as the match sees them: the required ones first, then the nice ones it compared. */
export function skillViews(match: MatchResultData, requiredKeys: readonly string[], labels: Labels): SkillView[] {
	const explanation = match.explanation;
	const matched = new Set(explanation.matches.flatMap((entry) => (entry.kind === 'skill' ? [entry.skill_key] : [])));
	const lacking = new Set(
		explanation.gaps.flatMap((gap) =>
			gap.code === 'required_skill_missing' || gap.code === 'nice_skill_missing' ? [gap.skill_key] : []
		)
	);
	const niceKeys = [
		...new Set(
			[
				...explanation.matches.flatMap((entry) =>
					entry.kind === 'skill' && entry.requirement === 'nice' ? [entry.skill_key] : []
				),
				...explanation.gaps.flatMap((gap) => (gap.code === 'nice_skill_missing' ? [gap.skill_key] : []))
			].filter((key) => !requiredKeys.includes(key))
		)
	];
	const skillOf = (key: string, required: boolean): SkillView => ({
		key,
		name: skillName(labels, key),
		required,
		have: matched.has(key) ? true : lacking.has(key) ? false : null
	});
	return [...requiredKeys.map((key) => skillOf(key, true)), ...niceKeys.map((key) => skillOf(key, false))];
}

/** Every component of the match with its weight; `value` is `null` when it was not computed. */
export function componentViews(match: MatchResultData): ComponentView[] {
	return (Object.keys(MATCH_COMPONENTS) as MatchComponentKey[]).map((key) => {
		const component = match.components[key];
		return {
			key,
			label: MATCH_COMPONENTS[key],
			value: component.status === 'computed' ? component.value : null,
			weight: component.weight
		};
	});
}

function card(item: Item, data: PageData, hrefOf: (id: string) => string, invitationHrefOf: (id: string) => string) {
	const labels = data.labels;
	const explanation = item.match.explanation;
	const skills = skillViews(item.match, item.requiredSkillKeys, labels);
	const components = componentViews(item.match);
	const grade =
		item.gradeMin === item.gradeMax
			? gradeName(labels, item.gradeMin)
			: `${gradeName(labels, item.gradeMin)} – ${gradeName(labels, item.gradeMax)}`;
	return {
		id: item.vacancyId,
		href: hrefOf(item.vacancyId),
		title: item.title,
		company: item.company,
		verified: item.companyVerification === 'verified',
		score: item.match.score,
		percent: percent.format(item.match.score),
		salaryText: salaryText(item.salary),
		salaryPeriod: item.salary.period === null ? null : SALARY_PERIODS[item.salary.period],
		salaryMin: item.salary.min,
		salaryMax: item.salary.max,
		grade,
		format: labels.workFormats[item.workFormat] ?? item.workFormat,
		skills,
		missing: skills.filter((skill) => skill.required && skill.have === false).map((skill) => skill.name),
		toVerify: explanation.to_verify.length,
		components,
		invitation: item.invitation ? { href: invitationHrefOf(item.invitation.id), status: item.invitation.status } : null,
		match: candidateMatchView(item.match, labels)
	} satisfies VacancyCard;
}

export function vacanciesView(
	data: PageData,
	links: {
		base: string;
		vacancy: (id: string) => string;
		invitation: (id: string) => string;
		applications: string;
		profile: string;
	}
): VacanciesView {
	const search = data.search;
	const queryOf = (cursor: string | null) => {
		const pairs: [string, string][] = [];
		if (search.text !== '') pairs.push(['q', search.text]);
		if (search.roleKey !== null) pairs.push(['role', search.roleKey]);
		if (search.gradeKey !== null) pairs.push(['grade', search.gradeKey]);
		for (const format of search.workFormats) pairs.push(['format', format]);
		if (cursor !== null) pairs.push(['cursor', cursor]);
		return `${links.base}?${pairs.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')}`;
	};
	return {
		cards: data.page.items.map((item) => card(item, data, links.vacancy, links.invitation)),
		search: {
			text: search.text,
			roleKey: search.roleKey,
			gradeKey: search.gradeKey,
			workFormats: search.workFormats,
			filtered:
				search.text !== '' || search.roleKey !== null || search.gradeKey !== null || search.workFormats.length > 0,
			roleOptions: Object.entries(data.labels.roles).sort(([, a], [, b]) => a.localeCompare(b, 'ru')),
			gradeOptions: Object.entries(data.labels.grades),
			formatOptions: Object.entries(data.labels.workFormats),
			firstHref: search.cursor === null ? null : queryOf(null),
			nextHref: data.page.nextCursor ? queryOf(data.page.nextCursor) : null,
			resetHref: links.base
		},
		degraded: data.page.mode.searchMode === 'fts_only',
		applicationsHref: links.applications,
		profileHref: links.profile
	};
}
