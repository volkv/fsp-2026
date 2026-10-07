/**
 * The match of a vacancy as the candidate reads it (docs/domain.md, section 13.4): the same decomposition the company
 * sees, worded for the candidate — what fits and what it rests on, what is unknown, what to check at the interview and
 * what to improve for this vacancy. Built from the stored result of `matchScore`.
 */
import { trustNote, type TrustDetails } from '$lib/components/employer/model.js';
import { inScore } from '$lib/matching/evidence-components.js';
import type { MatchComponentKey, MatchComponentStatus, MatchView } from '$lib/components/product/model.js';
import {
	gradeName,
	roleName,
	skillMark,
	skillName,
	STRENGTH_BANDS,
	type Attestation,
	type Labels,
	type TrustLevel
} from './model.js';

type ComponentStatus = 'computed' | 'unknown' | 'unavailable' | 'not_comparable';

interface ComponentData<Details = object> {
	value: number | null;
	weight: number;
	status: ComponentStatus;
	details: Details & { reason?: string };
}

/** The part of a stored `MatchResult` the candidate view reads. */
export interface MatchResultData {
	score: number;
	components: Record<Exclude<MatchComponentKey, 'role' | 'trust'>, ComponentData> & {
		role: ComponentData<{
			vacancy?: string;
			specializations?: string[];
			candidate?: string[];
			basis?: 'same_specialization' | 'other_specialization';
		}>;
		trust: ComponentData<TrustDetails>;
	};
	explanation: {
		matches: (
			| {
					kind: 'skill';
					requirement: 'required' | 'nice';
					skill_key: string;
					band: 'weak' | 'moderate' | 'strong';
					attestation: Attestation;
					badge_trust: TrustLevel | null;
			  }
			| { kind: 'role'; role_key: string }
			| { kind: 'grade'; vacancy: { min: string; max: string }; candidate: { min: string; max: string } }
			| { kind: 'salary'; comparison: 'lower' | 'equal' | 'overlap' }
		)[];
		unknown: { component: MatchComponentKey; status: Exclude<ComponentStatus, 'computed'>; reason: string }[];
		to_verify: { code: string; skill_key?: string }[];
		gaps: (
			| { code: 'required_skill_missing' | 'nice_skill_missing'; skill_key: string }
			| { code: 'grade_below'; steps: number }
			| { code: 'specialization_other' }
		)[];
	};
}

const COMPONENT_REASONS: Record<string, string> = {
	no_required_skills: 'в вакансии нет обязательных навыков',
	no_nice_skills: 'в вакансии нет желательных навыков',
	no_published_run: 'основания профиля ещё не рассчитаны',
	run_below_evidence_floor: 'профиль пересчитывается после изменения оснований',
	vacancy_grade_unknown: 'грейд вакансии не указан',
	category_not_confirmed: 'ваша категория не подтверждена: пройдите тест на грейд',
	specialization_other: 'ваша категория — другой специализации',
	candidate_grade_not_confirmed: 'грейд в специализации вакансии тестом не подтверждён',
	vacancy_role_unknown: 'роль вакансии не указана',
	vacancy_role_without_specialization: 'роль вакансии не относится к специализациям тестов',
	candidate_expectation_missing: 'вы не указали ожидания по зарплате',
	vacancy_salary_missing: 'в вакансии нет вилки',
	different_terms: 'разные валюта, период или налоговая база — сравнивать нельзя',
	no_active_space: 'смысловой поиск выключен — считаем по навыкам',
	pair_vector_missing: 'смысловой вектор ещё не посчитан',
	pair_not_reranked: 'уточняющая модель работает только в каталоге работодателя',
	outside_rerank_top_n: 'за пределами окна уточняющей модели',
	switched_off: 'модель выключена'
};

const reasonOf = (reason: string | undefined) => (reason ? (COMPONENT_REASONS[reason] ?? reason) : undefined);

const range = (labels: Labels, value: { min: string; max: string }) =>
	value.min === value.max
		? gradeName(labels, value.min)
		: `${gradeName(labels, value.min)} – ${gradeName(labels, value.max)}`;

const VERIFY: Record<string, string> = {
	category_not_confirmed:
		'Категория не подтверждена: без теста на грейд вы в подборках только отдельной группой «грейд не подтверждён» после подтверждённых и в поиске по всей базе — пройдите тест.',
	salary_not_comparable: 'Зарплату сравнить нельзя: разные валюта, период или налоговая база.',
	salary_expectation_missing: 'Ожидания по зарплате не указаны.',
	profile_recalculating: 'Профиль пересчитывается — соответствие уточнится.',
	profile_insufficient_data:
		'Недостаточно данных: основания профиля не рассчитаны — навыки пока не подтверждены, соответствие уточнится после расчёта.'
};

function verifyText(item: { code: string; skill_key?: string }, labels: Labels): string {
	const skill = item.skill_key ? skillName(labels, item.skill_key) : '';
	switch (item.code) {
		case 'skill_claimed':
			return `${skill}: только заявлено — будьте готовы показать на деле.`;
		case 'skill_derived':
			return `${skill}: выведено правилом из других фактов, прямого подтверждения нет.`;
		case 'skill_weak_evidence':
			return `${skill}: основания слабые.`;
		default:
			return VERIFY[item.code] ?? item.code;
	}
}

function gapText(item: MatchResultData['explanation']['gaps'][number], labels: Labels): string {
	if (item.code === 'specialization_other') return 'Ваша категория — другой специализации, чем у вакансии.';
	if (item.code === 'grade_below')
		return `Грейд ниже требуемого на ${item.steps} ${item.steps === 1 ? 'ступень' : 'ступени'}.`;
	const skill = skillName(labels, item.skill_key);
	return item.code === 'required_skill_missing'
		? `Апсолв: подтвердите обязательный навык «${skill}» — тестом платформы, профилем или опытом в резюме.`
		: `Плюсом будет «${skill}» (желательный навык).`;
}

function roleNote(details: MatchResultData['components']['role']['details'], labels: Labels): string | undefined {
	const names = (keys: readonly string[] | undefined) =>
		(keys ?? []).map((key) => labels.specializations[key] ?? key).join(', ');
	switch (details.basis) {
		case 'same_specialization':
			return `ваша категория ${names(details.candidate)} — специализация вакансии`;
		case 'other_specialization':
			return `ваша категория ${names(details.candidate)}, у вакансии — ${names(details.specializations)}`;
		default:
			return undefined;
	}
}

export function candidateMatchView(result: MatchResultData, labels: Labels): MatchView {
	const keys = Object.keys(result.components) as MatchComponentKey[];
	const scored = keys.filter((key) => inScore(key, result.components[key]));
	const totalWeight = scored.reduce((sum, key) => sum + result.components[key].weight, 0);
	return {
		score: result.score,
		components: keys.map((key) => {
			const component = result.components[key];
			const status: MatchComponentStatus = component.status;
			const reason = reasonOf(component.details.reason);
			const note =
				status !== 'computed'
					? undefined
					: key === 'role'
						? roleNote(result.components.role.details, labels)
						: key === 'trust'
							? trustNote(result.components.trust.details, 'candidate')
							: undefined;
			return {
				key,
				status,
				...(component.value === null ? {} : { value: component.value }),
				...(scored.includes(key) && totalWeight > 0 ? { weight: component.weight / totalWeight } : {}),
				...(reason === undefined ? {} : { reason }),
				...(note === undefined ? {} : { note })
			};
		}),
		matches: result.explanation.matches.map((item) => {
			switch (item.kind) {
				case 'skill':
					return {
						requirement: skillName(labels, item.skill_key),
						evidence: `${item.requirement === 'required' ? 'обязательный' : 'желательный'} · ${STRENGTH_BANDS[item.band]}`,
						trust: skillMark({ attestation: item.attestation, badgeTrust: item.badge_trust })
					};
				case 'role':
					return {
						requirement: roleName(labels, item.role_key),
						evidence: 'специализация вакансии — ваша категория',
						trust: 'derived'
					};
				case 'grade':
					return {
						requirement: `Грейд ${range(labels, item.vacancy)}`,
						evidence: `ваш грейд ${range(labels, item.candidate)} подтверждён тестом`,
						trust: 'derived'
					};
				case 'salary':
					return {
						requirement: 'Зарплата',
						evidence: item.comparison === 'lower' ? 'вилка выше ваших ожиданий' : 'вилка сходится с вашими ожиданиями',
						trust: 'claimed'
					};
			}
		}),
		unknown: result.explanation.unknown.map((item) => reasonOf(item.reason) ?? item.reason),
		toVerify: result.explanation.to_verify.map((item) => verifyText(item, labels)),
		gaps: result.explanation.gaps.map((item) => gapText(item, labels))
	};
}
