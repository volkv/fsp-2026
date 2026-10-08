import { describe, expect, it } from 'vitest';
import { disclosedFields, matchView, trustNote, type CompanyMatchData } from './model';

const labels = { roles: {}, specializations: {}, grades: {}, skills: {} };

type Components = CompanyMatchData['components'];

const computed = (weight: number, value = 1) => ({ value, weight, status: 'computed' as const, details: {} });
const unread = (weight: number, reason = 'no_published_run') => ({
	value: null,
	weight,
	status: 'unavailable' as const,
	details: { reason }
});

function match(components: Components, toVerify: CompanyMatchData['explanation']['to_verify'] = []): CompanyMatchData {
	return {
		score: 0.4,
		coverage: 0.5,
		components,
		explanation: { matches: [], unknown: [], to_verify: toVerify, gaps: [] }
	};
}

const weightsOf = (data: CompanyMatchData) =>
	Object.fromEntries(matchView(data, labels).components.map((c) => [c.key, c.weight]));

describe('trustNote', () => {
	it('names confirmations by FSP or a test apart from those of a public profile', () => {
		expect(
			trustNote({ direct: 1, total: 3, public_profile: 2, confirmed_coverage: 0.3, grade_agreement: null }, 'company')
		).toBe('подтверждено ФСП или тестом: 1 из 3; по публичному профилю: 2');
		expect(
			trustNote({ direct: 0, total: 2, public_profile: 1, confirmed_coverage: 0, grade_agreement: null }, 'company')
		).toBe('обязательные навыки не подтверждены ФСП или тестом; по публичному профилю: 1');
		expect(
			trustNote({ direct: 2, total: 2, public_profile: 0, confirmed_coverage: 1, grade_agreement: 0.5 }, 'company')
		).toBe('подтверждено ФСП или тестом: 2 из 2; диапазон грейда совпадает с требуемым на 50 %');
	});

	it('addresses the company or the candidate, and says nothing for a trust that was not computed', () => {
		const unset = {
			direct: 1,
			total: 2,
			public_profile: 0,
			confirmed_coverage: 0.5,
			grade_agreement: null,
			grade_agreement_reason: 'candidate_grade_not_confirmed' as const
		};
		expect(trustNote(unset, 'company')).toBe(
			'подтверждено ФСП или тестом: 1 из 2; грейд в специализации вакансии тестом не подтверждён — доверие снижено'
		);
		expect(trustNote(unset, 'candidate')).toBe(
			'подтверждено ФСП или тестом: 1 из 2; ваш грейд в специализации вакансии тестом не подтверждён — доверие снижено'
		);
		expect(trustNote({ reason: 'no_required_skills' }, 'company')).toBeUndefined();
	});
});

describe('matchView', () => {
	it('shares the weight among the computed components when the evidence was read', () => {
		const data = match({
			required: computed(0.4),
			nice: computed(0.1),
			trust: {
				...computed(0.1, 0.5),
				details: { direct: 1, total: 2, public_profile: 0, confirmed_coverage: 0.5, grade_agreement: null }
			},
			role: { ...computed(0.1), details: { basis: 'same_specialization', candidate: ['backend'] } },
			grade: { value: null, weight: 0.1, status: 'unknown', details: { reason: 'vacancy_grade_unknown' } },
			salary: computed(0.1),
			semantic: computed(0.1),
			reranker: { value: null, weight: 0.1, status: 'unavailable', details: { reason: 'switched_off' } }
		});
		const weights = weightsOf(data);
		expect(weights.required).toBeCloseTo(0.4 / 0.9);
		expect(weights.trust).toBeCloseTo(0.1 / 0.9);
		expect(weights.semantic).toBeCloseTo(0.1 / 0.9);
		expect([weights.grade, weights.reranker]).toEqual([undefined, undefined]);
	});

	it('keeps the weight of the evidence components of a candidate whose evidence could not be read', () => {
		for (const reason of ['no_published_run', 'run_below_evidence_floor']) {
			const data = match(
				{
					required: unread(0.4, reason),
					nice: unread(0.1, reason),
					trust: unread(0.1, reason),
					role: unread(0.1, reason),
					grade: unread(0.1, reason),
					salary: computed(0.1),
					semantic: computed(0.1),
					reranker: { value: null, weight: 0.1, status: 'unavailable', details: { reason: 'switched_off' } }
				},
				[{ code: 'profile_insufficient_data' }]
			);
			const weights = weightsOf(data);
			// Required, nice and trust count at the rule set's value: the shares are taken among them too.
			expect(weights.required).toBeCloseTo(0.4 / 0.8);
			expect(weights.nice).toBeCloseTo(0.1 / 0.8);
			expect(weights.trust).toBeCloseTo(0.1 / 0.8);
			expect(weights.salary).toBeCloseTo(0.1 / 0.8);
			// Role and grade may stay unestablished for a read candidate too: they drop out, as does a model switched off.
			expect([weights.role, weights.grade, weights.reranker]).toEqual([undefined, undefined, undefined]);
		}
	});

	it('says the evidence is not computed instead of treating its skills as checked', () => {
		const data = match(
			{
				required: unread(0.4),
				nice: unread(0.1),
				trust: unread(0.1),
				role: unread(0.1),
				grade: unread(0.1),
				salary: computed(0.1),
				semantic: computed(0.1),
				reranker: computed(0.1)
			},
			[{ code: 'profile_insufficient_data' }]
		);
		expect(matchView(data, labels).toVerify).toEqual([
			'Недостаточно данных: доказательства профиля ещё не рассчитаны — навыки в счёт идут как неподтверждённые, проверьте их на собеседовании'
		]);
	});
});

describe('disclosedFields', () => {
	it('lists as disclosed only the allowed fields the profile has a value for', () => {
		expect(
			disclosedFields({
				fields: ['full_name', 'email', 'telegram', 'phone'],
				fullName: { last: 'Родионов', first: 'Степан', middle: null },
				email: 'stepan@example.com',
				telegram: null,
				phone: ''
			})
		).toEqual({ disclosed: ['full_name', 'email'], empty: ['telegram', 'phone'] });
	});
});
