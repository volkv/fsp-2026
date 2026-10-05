import { describe, expect, it } from 'vitest';
import { candidateMatchView, type MatchResultData } from './match';

const labels = { roles: {}, specializations: {}, grades: {}, skills: {}, workFormats: {}, employmentForms: {} };

function withTrust(details: MatchResultData['components']['trust']['details']): MatchResultData {
	const off = { value: null, weight: 0.1, status: 'unknown' as const, details: { reason: 'no_nice_skills' } };
	return {
		score: 0.5,
		components: {
			required: { value: 1, weight: 0.45, status: 'computed', details: {} },
			nice: off,
			grade: off,
			salary: off,
			semantic: off,
			reranker: off,
			role: off,
			trust: { value: 0, weight: 0.1, status: 'computed', details }
		},
		explanation: { matches: [], unknown: [], to_verify: [], gaps: [] }
	};
}

const trustNoteOf = (result: MatchResultData) =>
	candidateMatchView(result, labels).components.find((c) => c.key === 'trust')?.note;

describe('candidateMatchView', () => {
	it('names confirmations by FSP or a test apart from those of a public profile', () => {
		expect(
			trustNoteOf(withTrust({ direct: 0, total: 1, public_profile: 1, confirmed_coverage: 0, grade_agreement: null }))
		).toBe('обязательные навыки не подтверждены ФСП или тестом; по публичному профилю: 1');
		expect(
			trustNoteOf(withTrust({ direct: 1, total: 2, public_profile: 0, confirmed_coverage: 0.5, grade_agreement: null }))
		).toBe('подтверждено ФСП или тестом: 1 из 2');
	});
});

describe('candidateMatchView weights', () => {
	const computed = (weight: number) => ({ value: 1, weight, status: 'computed' as const, details: {} });
	const unread = (weight: number) => ({
		value: null,
		weight,
		status: 'unavailable' as const,
		details: { reason: 'no_published_run' }
	});
	const weightsOf = (components: MatchResultData['components']) =>
		Object.fromEntries(
			candidateMatchView(
				{ score: 0.4, components, explanation: { matches: [], unknown: [], to_verify: [], gaps: [] } },
				labels
			).components.map((c) => [c.key, c.weight])
		);

	it('shares the weight among the computed components', () => {
		const weights = weightsOf({
			required: computed(0.4),
			nice: computed(0.1),
			trust: {
				...computed(0.1),
				details: { direct: 1, total: 1, public_profile: 0, confirmed_coverage: 1, grade_agreement: null }
			},
			role: computed(0.1),
			grade: { value: null, weight: 0.1, status: 'unknown', details: { reason: 'vacancy_grade_unknown' } },
			salary: computed(0.1),
			semantic: computed(0.1),
			reranker: { value: null, weight: 0.1, status: 'unavailable', details: { reason: 'pair_not_reranked' } }
		});
		expect(weights.required).toBeCloseTo(0.4 / 0.9);
		expect([weights.grade, weights.reranker]).toEqual([undefined, undefined]);
	});

	it('keeps required, nice and trust in the shares while the category is not computed', () => {
		const weights = weightsOf({
			required: unread(0.4),
			nice: unread(0.1),
			trust: unread(0.1),
			role: unread(0.1),
			grade: unread(0.1),
			salary: computed(0.1),
			semantic: computed(0.1),
			reranker: { value: null, weight: 0.1, status: 'unavailable', details: { reason: 'pair_not_reranked' } }
		});
		expect(weights.required).toBeCloseTo(0.4 / 0.8);
		expect(weights.nice).toBeCloseTo(0.1 / 0.8);
		expect(weights.trust).toBeCloseTo(0.1 / 0.8);
		expect(weights.semantic).toBeCloseTo(0.1 / 0.8);
		expect([weights.role, weights.grade, weights.reranker]).toEqual([undefined, undefined, undefined]);
	});
});
