import { describe, expect, it, vi } from 'vitest';
import type { NeedReason } from '$lib/server/matching/score';
import type { CandidateCard } from '$lib/server/visibility/projections';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { offerTermsOfNeed, whyYouFromShortlist, whyYouOptions } = await import('./offer-form');
const { reasonText } = await import('$lib/components/employer/shortlist');

describe('offerTermsOfNeed', () => {
	it('starts an offer from a shortlist with the format and the range of its need', () => {
		expect(
			offerTermsOfNeed({
				skill_keys: ['go'],
				nice_skill_keys: [],
				work_format: 'hybrid',
				salary: { min: 250_000, max: 320_000, currency: 'RUB', period: 'month', tax_base: 'net' }
			})
		).toEqual({ workFormat: 'hybrid', salary: { min: 250_000, max: 320_000, taxBase: 'net' } });
	});

	it('leaves a term the need does not state to the employer', () => {
		expect(offerTermsOfNeed({ skill_keys: ['go'], nice_skill_keys: [] })).toEqual({ workFormat: null, salary: null });
	});
});

const generalized = {
	discipline: 'product',
	competitionLevel: 'russian_championship',
	season: 2025,
	resultGroup: 'winner' as const,
	teamResult: false,
	format: 'onsite' as const,
	computedIndicator: null
};
const NO_NAMES = { skills: {}, workFormats: {} };

describe('«why you» of an FSP result', () => {
	it('names the competition and the place the way the profile does when the card shows the result exactly', () => {
		const card: CandidateCard = {
			projection: 'catalog',
			fspAchievements: [
				{
					generalized,
					exact: {
						competitionRef: 'c-1',
						competitionTitle: 'Чемпионат России по продуктовому программированию',
						stage: null,
						place: 1,
						placeOf: 19,
						team: null,
						protocolUrl: null
					},
					preliminary: false,
					receiptHandles: ['r-1']
				}
			]
		};
		expect(whyYouOptions(card, NO_NAMES).map((option) => option.text)).toEqual([
			'1 место из 19 · Чемпионат России по продуктовому программированию'
		]);
	});

	it('names what a generalized card shows, and offers no point of a preliminary result', () => {
		const card: CandidateCard = {
			projection: 'catalog',
			fspAchievements: [
				{ generalized, preliminary: false, receiptHandles: ['r-1'] },
				{ generalized: { ...generalized, season: 2026 }, preliminary: true, receiptHandles: ['r-2'] }
			]
		};
		expect(whyYouOptions(card, NO_NAMES).map((option) => option.text)).toEqual([
			'Победитель · Чемпионат России · Программирование продуктовое, 2025'
		]);
	});
});

describe('«why you» of a team result', () => {
	const championship = {
		competitionRef: 'c-1',
		competitionTitle: 'Чемпионат России по продуктовому программированию',
		stage: null,
		place: 1,
		placeOf: 19,
		team: { name: 'Северный код', role: 'captain' },
		protocolUrl: null
	};
	const teamWin = { ...generalized, teamResult: true };

	it('marks a team result as the team’s, exactly and generalized, never as a personal one', () => {
		const card: CandidateCard = {
			projection: 'catalog',
			fspAchievements: [
				{ generalized: teamWin, exact: championship, preliminary: false, receiptHandles: ['r-1'] },
				{ generalized: teamWin, preliminary: false, receiptHandles: ['r-2'] }
			]
		};
		expect(whyYouOptions(card, NO_NAMES).map((option) => option.text)).toEqual([
			'1 место из 19 в составе команды «Северный код» · Чемпионат России по продуктовому программированию',
			'Победитель в составе команды · Чемпионат России · Программирование продуктовое, 2025'
		]);
	});

	it('words the FSP record of the offer as the shortlist does, and its team podium the same way', () => {
		const reason: NeedReason = {
			code: 'fsp_record',
			competitions: 2,
			podiums: 1,
			team_podiums: 1,
			relevant: null,
			contribution: 0.05,
			source: { kind: 'fsp_fact', fact_ids: ['f-0', 'f-1'] }
		};
		const names = { skills: {}, workFormats: {}, specializations: {}, grades: {} };
		const card: CandidateCard = {
			projection: 'catalog',
			fspAchievements: [
				{
					generalized: { ...generalized, resultGroup: 'participant', season: 2026 },
					exact: {
						...championship,
						competitionTitle: 'Кубок России',
						place: 5,
						placeOf: null,
						team: championship.team
					},
					preliminary: false,
					receiptHandles: ['r-0']
				},
				{ generalized: teamWin, exact: championship, preliminary: false, receiptHandles: ['r-1'] }
			]
		};
		const points = whyYouFromShortlist({ reasons: [reason] }, whyYouOptions(card, NO_NAMES), names);
		const shortlist = reasonText(reason, { ...names, roles: {}, blocks: {} }, { fspSimulator: false }).text;
		expect(points.map((point) => point.text)).toEqual([
			`Результаты ФСП: ${shortlist}`,
			'1 место из 19 в составе команды «Северный код» · Чемпионат России по продуктовому программированию'
		]);
		expect(shortlist).toBe('2 соревнования ФСП, из них 1 призовое — в составе команды');
	});
});

describe('«why you» of a category', () => {
	it('names the category as the shortlist does: «Backend · Средний»', () => {
		const points = whyYouFromShortlist(
			{
				reasons: [
					{
						code: 'test_result',
						specialization: 'backend',
						grade: 'middle',
						margin: 0.2,
						contribution: 0.1,
						source: { kind: 'test_block', ref: 'be.algo', specialization: 'backend', grade: 'middle' }
					}
				]
			},
			[],
			{
				skills: {},
				workFormats: {},
				specializations: { backend: 'Backend' },
				grades: { middle: 'Средний' }
			}
		);
		expect(points.map((point) => point.text)).toEqual([
			'Категория Backend · Средний подтверждена тестом; сильнее всего — блок «Алгоритмы и структуры данных»'
		]);
	});
});
