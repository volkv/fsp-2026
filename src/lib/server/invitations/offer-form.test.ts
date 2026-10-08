import { describe, expect, it, vi } from 'vitest';
import type { CandidateCard } from '$lib/server/visibility/projections';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { offerTermsOfNeed, whyYouFromShortlist, whyYouOptions } = await import('./offer-form');

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
