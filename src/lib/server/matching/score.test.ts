import { describe, expect, it } from 'vitest';
import matchRuleset from '../../../../taxonomy/match-ruleset.json';
import { matchRulesetParamsSchema } from './params';
import { matchScore, qualifiesForPool, type CategoryAxes, type MatchInput, type SkillEvidence } from './score';

/** The rule set the product ships. */
const params = matchRulesetParamsSchema.parse(matchRuleset.params);
const gradeOrdinals = new Map([
	['intern', 0],
	['junior', 1],
	['middle', 2],
	['senior', 3],
	['lead', 4],
	['principal', 5]
]);

const goFromFsp: SkillEvidence = {
	skillKey: 'go',
	band: 'strong',
	attestation: 'direct',
	badgeTrust: 'fsp_verified',
	factIds: ['fact-fsp']
};
const goFromGithub: SkillEvidence = {
	skillKey: 'go',
	band: 'strong',
	attestation: 'direct',
	badgeTrust: 'public_verifiable',
	factIds: ['fact-github']
};
const goFromTest: SkillEvidence = { ...goFromGithub, badgeTrust: 'platform_verified', factIds: ['fact-test'] };
const goFromResume: SkillEvidence = {
	skillKey: 'go',
	band: 'strong',
	attestation: 'claimed',
	badgeTrust: null,
	factIds: ['fact-resume']
};

function input(overrides: Partial<MatchInput> = {}): MatchInput {
	return {
		vacancy: {
			roleKey: 'backend',
			grade: { min: 'middle', max: 'senior' },
			requiredSkillKeys: ['go', 'postgresql'],
			niceSkillKeys: ['kubernetes'],
			salary: { min: 250_000, max: 350_000, currency: 'RUB', period: 'month', taxBase: 'gross' }
		},
		candidate: {
			evidence: {
				status: 'available',
				runId: 'run-1',
				skills: [
					goFromFsp,
					{
						skillKey: 'postgresql',
						band: 'moderate',
						attestation: 'claimed',
						badgeTrust: null,
						factIds: ['fact-resume']
					}
				],
				categories: [{ rank: 'primary', roleKey: 'backend', grade: { min: 'middle', max: 'middle' } }]
			},
			desiredRoleKeys: [],
			salaryExpectation: { min: 300_000, max: null, currency: 'RUB', period: 'month', taxBase: 'gross' }
		},
		params,
		gradeOrdinals,
		semantic: { status: 'computed', cosine: 0.8, spaceId: 'space-1' },
		reranker: { status: 'computed', score: 0.9, modelId: 'reranker-1' },
		...overrides
	};
}

function withSkills(skills: SkillEvidence[]): MatchInput {
	const base = input();
	if (base.candidate.evidence.status !== 'available') throw new Error('fixture evidence must be available');
	return { ...base, candidate: { ...base.candidate, evidence: { ...base.candidate.evidence, skills } } };
}

/** The fixture candidate with other categories and desired roles. */
function withCategories(categories: CategoryAxes[], desiredRoleKeys: string[] = [], base = input()): MatchInput {
	if (base.candidate.evidence.status !== 'available') throw new Error('fixture evidence must be available');
	return {
		...base,
		candidate: { ...base.candidate, desiredRoleKeys, evidence: { ...base.candidate.evidence, categories } }
	};
}

const middle = { min: 'middle', max: 'middle' };

describe('matchScore', () => {
	it('computes every component and explains what matches', () => {
		const result = matchScore(input());
		expect(Object.values(result.components).map((c) => c.status)).toEqual(Array(8).fill('computed'));
		expect(result.coverage).toBe(1);
		expect(result.score).toBeGreaterThan(0.5);
		expect(result.explanation.matches).toContainEqual({
			kind: 'skill',
			requirement: 'required',
			skill_key: 'go',
			band: 'strong',
			attestation: 'direct',
			badge_trust: 'fsp_verified',
			fact_ids: ['fact-fsp']
		});
		expect(result.explanation.matches).toContainEqual({ kind: 'role', role_key: 'backend' });
		expect(result.explanation.to_verify).toContainEqual({ code: 'skill_claimed', skill_key: 'postgresql' });
		expect(result.explanation.gaps).toEqual([{ code: 'nice_skill_missing', skill_key: 'kubernetes' }]);
	});

	it('reports a missing required skill as a gap with zero coverage', () => {
		const result = matchScore(withSkills([goFromFsp]));
		expect(result.components.required.details.skills).toContainEqual({
			skill_key: 'postgresql',
			band: null,
			attestation: null,
			badge_trust: null,
			value: 0
		});
		expect(result.components.required.value).toBe(0.5);
		expect(result.explanation.gaps).toContainEqual({ code: 'required_skill_missing', skill_key: 'postgresql' });
		expect(result.explanation.matches.some((m) => m.kind === 'skill' && m.skill_key === 'postgresql')).toBe(false);
	});

	it('counts a skill confirmed by FSP as trusted and the same skill claimed in a resume as not', () => {
		const confirmed = matchScore(withSkills([goFromFsp]));
		const claimed = matchScore(withSkills([goFromResume]));
		// Coverage is the same: both have strong grounds for Go.
		expect(confirmed.components.required.value).toBe(claimed.components.required.value);
		expect(confirmed.components.trust).toMatchObject({
			status: 'computed',
			value: 0.5,
			details: { direct: 1, total: 2, confirmed_coverage: 0.5, grade_agreement: 1 }
		});
		expect(claimed.components.trust).toMatchObject({ status: 'computed', value: 0, details: { direct: 0, total: 2 } });
		expect(confirmed.score).toBeGreaterThan(claimed.score);
		expect(claimed.explanation.to_verify).toContainEqual({ code: 'skill_claimed', skill_key: 'go' });
		expect(confirmed.explanation.to_verify).not.toContainEqual({ code: 'skill_claimed', skill_key: 'go' });
	});

	it('counts a platform test as a confirmation and a public profile apart from them', () => {
		const tested = matchScore(withSkills([goFromTest]));
		const github = matchScore(withSkills([goFromGithub]));
		const claimed = matchScore(withSkills([goFromResume]));
		expect(tested.components.trust).toMatchObject({
			value: 0.5,
			details: { direct: 1, total: 2, public_profile: 0, confirmed_coverage: 0.5 }
		});
		// Repository languages cover the requirement as strongly as the test, but do not confirm it.
		expect(github.components.required.value).toBe(tested.components.required.value);
		expect(github.components.trust).toMatchObject({
			status: 'computed',
			value: 0,
			details: { direct: 0, total: 2, public_profile: 1, confirmed_coverage: 0 }
		});
		expect(github.score).toBe(claimed.score);
		expect(tested.score).toBeGreaterThan(github.score);
		// The badge still reaches the explanation, and the skill asks for no check as a claim would.
		expect(github.explanation.matches).toContainEqual({
			kind: 'skill',
			requirement: 'required',
			skill_key: 'go',
			band: 'strong',
			attestation: 'direct',
			badge_trust: 'public_verifiable',
			fact_ids: ['fact-github']
		});
		expect(github.explanation.to_verify).not.toContainEqual({ code: 'skill_claimed', skill_key: 'go' });
	});

	it('does not compare a range in another tax base and does not let it change the score', () => {
		const net = input({
			candidate: {
				...input().candidate,
				salaryExpectation: { min: 300_000, max: null, currency: 'RUB', period: 'month', taxBase: 'net' }
			}
		});
		const result = matchScore(net);
		expect(result.components.salary).toMatchObject({
			status: 'not_comparable',
			value: null,
			details: {
				comparison: 'not_comparable',
				vacancy: { tax_base: 'gross' },
				candidate: { tax_base: 'net' }
			}
		});
		expect(result.explanation.to_verify).toContainEqual({ code: 'salary_not_comparable' });
		expect(result.explanation.matches.some((m) => m.kind === 'salary')).toBe(false);
		expect(result.explanation.unknown).toContainEqual({
			component: 'salary',
			status: 'not_comparable',
			reason: 'different_terms'
		});
		// The score is the one without the salary component: neither a penalty nor a guess.
		const withoutSalary = matchScore({ ...net, params: { ...params, weights: { ...params.weights, salary: 0 } } });
		expect(result.score).toBe(withoutSalary.score);
	});

	it('marks semantic and reranker components unavailable when the models are off', () => {
		const off = input({
			semantic: { status: 'unavailable', reason: 'disabled' },
			reranker: { status: 'unavailable', reason: 'disabled' }
		});
		const result = matchScore(off);
		expect(result.components.semantic).toEqual({
			value: null,
			weight: params.weights.semantic,
			status: 'unavailable',
			details: { reason: 'disabled' }
		});
		expect(result.components.reranker).toMatchObject({ status: 'unavailable', value: null });
		expect(result.explanation.unknown).toEqual([
			{ component: 'semantic', status: 'unavailable', reason: 'disabled' },
			{ component: 'reranker', status: 'unavailable', reason: 'disabled' }
		]);
		const { weights } = params;
		const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
		expect(result.coverage).toBe(Math.round(((total - weights.semantic - weights.reranker) / total) * 1000) / 1000);
		// Weights of the computed components are renormalized: the models being off is not a penalty.
		const rest = ['required', 'nice', 'role', 'trust', 'grade', 'salary'] as const;
		const expected =
			rest.reduce((sum, key) => sum + params.weights[key] * (result.components[key].value ?? 0), 0) /
			rest.reduce((sum, key) => sum + params.weights[key], 0);
		expect(result.score).toBe(Math.round(expected * 1000) / 1000);
	});

	it('treats an unset grade as unknown to verify, not as a mismatch', () => {
		const base = input();
		const result = matchScore({
			...base,
			candidate: {
				...base.candidate,
				evidence: {
					status: 'available',
					runId: 'run-1',
					skills: [goFromFsp],
					categories: [{ rank: 'primary', roleKey: 'backend', grade: null }]
				}
			}
		});
		expect(result.components.grade).toMatchObject({
			status: 'unknown',
			details: { reason: 'candidate_grade_not_established' }
		});
		expect(result.explanation.to_verify).toContainEqual({ code: 'grade_not_established' });
	});

	it('penalizes each grade step between disjoint ranges and reports the gap', () => {
		const base = input();
		const result = matchScore({
			...base,
			candidate: {
				...base.candidate,
				evidence: {
					status: 'available',
					runId: 'run-1',
					skills: [goFromFsp],
					categories: [{ rank: 'primary', roleKey: 'backend', grade: { min: 'junior', max: 'junior' } }]
				}
			}
		});
		expect(result.components.grade).toMatchObject({
			status: 'computed',
			value: 0.5,
			details: { position: 'below', steps: 1 }
		});
		expect(result.explanation.gaps).toContainEqual({ code: 'grade_below', steps: 1 });
	});

	it('makes evidence of an invalidated run unavailable instead of scoring it', () => {
		const base = input();
		const result = matchScore({
			...base,
			candidate: { ...base.candidate, evidence: { status: 'unavailable', reason: 'run_below_evidence_floor' } }
		});
		for (const key of ['required', 'nice', 'role', 'trust', 'grade'] as const) {
			expect(result.components[key]).toMatchObject({
				status: 'unavailable',
				details: { reason: 'run_below_evidence_floor' }
			});
		}
		expect(result.explanation.matches.some((m) => m.kind === 'skill')).toBe(false);
		expect(result.explanation.to_verify).toContainEqual({ code: 'profile_recalculating' });
		expect(result.explanation.to_verify).not.toContainEqual({ code: 'profile_insufficient_data' });
	});

	describe('a candidate without a usable categorization run', () => {
		const modelsOff = {
			semantic: { status: 'unavailable', reason: 'disabled' },
			reranker: { status: 'unavailable', reason: 'disabled' }
		} as const;
		const withoutRun = (reason: 'no_published_run' | 'run_below_evidence_floor') => {
			const base = input(modelsOff);
			return matchScore({ ...base, candidate: { ...base.candidate, evidence: { status: 'unavailable', reason } } });
		};

		it('ranks below a read candidate whose skills match, and says there is not enough data', () => {
			const noRun = withoutRun('no_published_run');
			// Read, with the required skills only claimed in the resume: nothing confirmed directly, the same salary.
			const read = matchScore({
				...withSkills([
					goFromResume,
					{ skillKey: 'postgresql', band: 'weak', attestation: 'claimed', badgeTrust: null, factIds: ['fact-resume'] }
				]),
				...modelsOff
			});

			// The salary is the only computed component, yet the score does not rest on it alone.
			expect(noRun.components.salary).toMatchObject({ status: 'computed', value: 1 });
			const { weights } = params;
			expect(noRun.coverage).toBe(
				Math.round((weights.salary / Object.values(weights).reduce((a, b) => a + b, 0)) * 1000) / 1000
			);
			const held = weights.required + weights.nice + weights.trust;
			expect(noRun.score).toBe(
				Math.round(((weights.salary + held * params.unavailableEvidenceValue) / (weights.salary + held)) * 1000) / 1000
			);
			expect(noRun.score).toBeLessThan(read.score);
			expect(noRun.explanation.to_verify).toContainEqual({ code: 'profile_insufficient_data' });
			expect(noRun.explanation.to_verify).not.toContainEqual({ code: 'profile_recalculating' });
		});

		it('scores as a read candidate with no confirmed skills, whatever the reason', () => {
			const empty = matchScore(withCategories([], [], { ...withSkills([]), ...modelsOff }));
			expect(empty.components.role.status).toBe('unknown');
			expect(empty.components.grade.status).toBe('unknown');
			expect(withoutRun('no_published_run').score).toBe(empty.score);
			expect(withoutRun('run_below_evidence_floor').score).toBe(empty.score);
		});
	});

	it('keeps an external vacancy without range and grade unknown, not penalized', () => {
		const base = input();
		const result = matchScore({
			...base,
			vacancy: {
				...base.vacancy,
				grade: null,
				salary: { min: null, max: null, currency: null, period: null, taxBase: null }
			}
		});
		expect(result.components.grade).toMatchObject({ status: 'unknown', details: { reason: 'vacancy_grade_unknown' } });
		expect(result.components.salary).toMatchObject({
			status: 'unknown',
			details: { reason: 'vacancy_salary_missing' }
		});
	});

	it('reads a logit reranker through a sigmoid and refuses a probability outside [0, 1]', () => {
		const logit = matchScore(
			input({
				params: { ...params, reranker: { scale: 'logit' } },
				reranker: { status: 'computed', score: 0, modelId: 'r' }
			})
		);
		expect(logit.components.reranker.value).toBe(0.5);
		const outside = matchScore(input({ reranker: { status: 'computed', score: 3.2, modelId: 'r' } }));
		expect(outside.components.reranker).toMatchObject({
			status: 'unavailable',
			details: { reason: 'score_outside_probability_scale' }
		});
	});

	it('scores 0 with zero coverage when nothing can be computed', () => {
		const result = matchScore({
			...input(),
			vacancy: {
				roleKey: null,
				grade: null,
				requiredSkillKeys: [],
				niceSkillKeys: [],
				salary: { min: null, max: null, currency: null, period: null, taxBase: null }
			},
			semantic: { status: 'unavailable', reason: 'no_active_space' },
			reranker: { status: 'unavailable', reason: 'disabled' }
		});
		expect(result.score).toBe(0);
		expect(result.coverage).toBe(0);
		expect(result.explanation.unknown).toHaveLength(8);
	});
});

describe('role component', () => {
	it('is 1 for the primary role, the rule set value for a secondary or only desired one, 0 for another role', () => {
		const primary = matchScore(input());
		expect(primary.components.role).toMatchObject({
			status: 'computed',
			value: 1,
			details: { vacancy: 'backend', candidate: ['backend'], basis: 'primary' }
		});

		const secondary = matchScore(
			withCategories([
				{ rank: 'primary', roleKey: 'devops', grade: middle },
				{ rank: 'secondary', roleKey: 'backend', grade: middle }
			])
		);
		expect(secondary.components.role).toMatchObject({
			value: params.role.secondary,
			details: { candidate: ['devops', 'backend'], basis: 'secondary' }
		});
		expect(secondary.explanation.matches).toContainEqual({ kind: 'role', role_key: 'backend' });

		const desired = matchScore(withCategories([{ rank: 'primary', roleKey: 'devops', grade: middle }], ['backend']));
		expect(desired.components.role).toMatchObject({ value: params.role.desired, details: { basis: 'desired' } });
		expect(desired.explanation.matches.some((m) => m.kind === 'role')).toBe(false);
		expect(desired.explanation.to_verify).toContainEqual({ code: 'role_desired_only' });

		const other = matchScore(withCategories([{ rank: 'primary', roleKey: 'devops', grade: middle }]));
		expect(other.components.role).toMatchObject({ status: 'computed', value: 0, details: { basis: 'none' } });
		expect(other.explanation.gaps).toContainEqual({ code: 'role_other' });

		expect(primary.score).toBeGreaterThan(secondary.score);
		expect(secondary.score).toBeGreaterThan(desired.score);
		expect(desired.score).toBeGreaterThan(other.score);
	});

	it('keeps a role the categorization did not establish unknown, not penalized', () => {
		const unset = withCategories([{ rank: 'primary', roleKey: null, grade: middle }]);
		const result = matchScore(unset);
		expect(result.components.role).toMatchObject({
			status: 'unknown',
			value: null,
			details: { reason: 'candidate_role_not_established' }
		});
		expect(result.explanation.to_verify).toContainEqual({ code: 'role_not_established' });
		expect(result.explanation.gaps).not.toContainEqual({ code: 'role_other' });
		const withoutRole = matchScore({ ...unset, params: { ...params, weights: { ...params.weights, role: 0 } } });
		expect(result.score).toBe(withoutRole.score);
	});

	it('is unknown for a vacancy without a role', () => {
		const base = input();
		const result = matchScore({ ...base, vacancy: { ...base.vacancy, roleKey: null } });
		expect(result.components.role).toMatchObject({ status: 'unknown', details: { reason: 'vacancy_role_unknown' } });
	});

	it('ranks the candidate of the vacancy role above one of a neighbouring role with the same skills confirmed', () => {
		const dataVacancy = (base: MatchInput): MatchInput => ({
			...base,
			vacancy: { ...base.vacancy, roleKey: 'data_engineer' }
		});
		// A data analyst with both required skills confirmed by tests against a data engineer who only claims them.
		const analyst = dataVacancy(
			withCategories(
				[{ rank: 'primary', roleKey: 'data_analyst', grade: middle }],
				[],
				withSkills([goFromFsp, { ...goFromFsp, skillKey: 'postgresql' }])
			)
		);
		const engineer = dataVacancy(
			withCategories(
				[{ rank: 'primary', roleKey: 'data_engineer', grade: middle }],
				[],
				withSkills([goFromResume, { ...goFromResume, skillKey: 'postgresql' }])
			)
		);
		expect(matchScore(engineer).score).toBeGreaterThan(matchScore(analyst).score);
	});
});

describe('trust component', () => {
	it('weighs direct confirmations by their band', () => {
		const weak = matchScore(withSkills([{ ...goFromFsp, band: 'weak' }]));
		expect(weak.components.trust).toMatchObject({
			value: params.skillBandValue.weak / 2,
			details: { direct: 1, total: 2, confirmed_coverage: params.skillBandValue.weak / 2 }
		});
	});

	it('scales the confirmed coverage by the share of the candidate grade range inside the vacancy range', () => {
		const wide = matchScore(
			withCategories([{ rank: 'primary', roleKey: 'backend', grade: { min: 'junior', max: 'senior' } }])
		);
		// Middle and senior of junior–senior lie in the vacancy's middle–senior.
		const details = wide.components.trust.details;
		expect('grade_agreement' in details && details.grade_agreement).toBeCloseTo(2 / 3);
		expect(wide.components.trust.value).toBeCloseTo(0.5 * (1 - params.trust.gradeWeight * (1 / 3)));

		const disjoint = matchScore(
			withCategories([{ rank: 'primary', roleKey: 'backend', grade: { min: 'lead', max: 'lead' } }])
		);
		expect(disjoint.components.trust).toMatchObject({ details: { grade_agreement: 0 } });
		// The grade never takes all of the trust: a directly confirmed skill keeps the pair in the pool count.
		expect(disjoint.components.trust.value).toBeCloseTo(0.5 * (1 - params.trust.gradeWeight));
		expect(disjoint.components.trust.value ?? 0).toBeGreaterThan(0);
	});

	it('lowers the trust for a grade that is not established and says so', () => {
		const result = matchScore(withCategories([{ rank: 'primary', roleKey: 'backend', grade: null }]));
		expect(result.components.trust).toMatchObject({
			status: 'computed',
			details: { grade_agreement: null, grade_agreement_reason: 'candidate_grade_not_established' }
		});
		expect(result.components.trust.value).toBeCloseTo(
			0.5 * (1 - params.trust.gradeWeight * (1 - params.trust.unknownGradeAgreement))
		);
		const base = input();
		const noVacancyGrade = matchScore({ ...base, vacancy: { ...base.vacancy, grade: null } });
		expect(noVacancyGrade.components.trust).toMatchObject({
			value: 0.5,
			details: { grade_agreement: null, grade_agreement_reason: 'vacancy_grade_unknown' }
		});
	});

	it('ranks a lead who claims the skills above a junior with both confirmed for a lead vacancy', () => {
		// Without the model components, which would dilute what the rules decide.
		const leadVacancy = (base: MatchInput): MatchInput => ({
			...base,
			vacancy: { ...base.vacancy, grade: { min: 'lead', max: 'lead' } },
			semantic: { status: 'unavailable', reason: 'disabled' },
			reranker: { status: 'unavailable', reason: 'disabled' }
		});
		const junior = leadVacancy(
			withCategories(
				[{ rank: 'primary', roleKey: 'backend', grade: { min: 'junior', max: 'junior' } }],
				[],
				withSkills([goFromFsp, { ...goFromFsp, skillKey: 'postgresql' }])
			)
		);
		const lead = leadVacancy(
			withCategories(
				[{ rank: 'primary', roleKey: 'backend', grade: { min: 'lead', max: 'lead' } }],
				[],
				withSkills([goFromResume, { ...goFromResume, skillKey: 'postgresql' }])
			)
		);
		expect(matchScore(lead).score).toBeGreaterThan(matchScore(junior).score);
	});
});

describe('match rule set parameters', () => {
	it('refuses a band worth nothing and a grade agreement that takes all of the trust', () => {
		const shipped = matchRuleset.params;
		expect(
			matchRulesetParamsSchema.safeParse({ ...shipped, skillBandValue: { ...shipped.skillBandValue, weak: 0 } }).success
		).toBe(false);
		expect(
			matchRulesetParamsSchema.safeParse({ ...shipped, trust: { ...shipped.trust, gradeWeight: 1 } }).success
		).toBe(false);
	});
});

describe('qualifiesForPool', () => {
	it('needs the threshold and a required skill confirmed by FSP or a platform test', () => {
		const postgresql = { ...goFromResume, skillKey: 'postgresql' };
		const confirmed = matchScore(withSkills([goFromFsp, postgresql]));
		const tested = matchScore(withSkills([goFromTest, postgresql]));
		const github = matchScore(withSkills([goFromGithub, { ...goFromGithub, skillKey: 'postgresql' }]));
		const claimed = matchScore(withSkills([goFromResume, postgresql]));
		for (const result of [confirmed, tested, github, claimed]) {
			expect(result.score).toBeGreaterThanOrEqual(params.poolThreshold);
		}
		expect(qualifiesForPool(confirmed.score, confirmed.components.trust, params)).toBe(true);
		expect(qualifiesForPool(tested.score, tested.components.trust, params)).toBe(true);
		// Every required skill attested by a public profile alone is not «confirmed».
		expect(qualifiesForPool(github.score, github.components.trust, params)).toBe(false);
		expect(qualifiesForPool(claimed.score, claimed.components.trust, params)).toBe(false);
		expect(qualifiesForPool(params.poolThreshold - 0.001, confirmed.components.trust, params)).toBe(false);
		// The trust component says the same as the explanation: a required skill with a confirming badge.
		for (const result of [confirmed, tested, github, claimed]) {
			const confirming = result.explanation.matches.some(
				(m) =>
					m.kind === 'skill' &&
					m.requirement === 'required' &&
					m.attestation === 'direct' &&
					(m.badge_trust === 'fsp_verified' || m.badge_trust === 'platform_verified')
			);
			expect((result.components.trust.value ?? 0) > 0).toBe(confirming);
		}
	});
});
