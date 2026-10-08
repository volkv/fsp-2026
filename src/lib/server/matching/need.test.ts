// Ranking for a hiring need (docs/domain.md, section 13.10): candidates covering every required skill come first, then
// by the number of unconfirmed ones — missing, unknown and claimed told apart; what a candidate says of themselves is
// worth its band under a ceiling below what a check confirms, the two levels add up with exact contributions, the FSP
// record is a bonus by competitions and podiums and never a penalty, the test is read by blocks, a candidate without a
// category of the need goes after every confirmed one, and the semantic similarity only orders almost equal scores.
import { describe, expect, it } from 'vitest';
import matchRuleset from '../../../../taxonomy/match-ruleset.json';
import { matchRulesetParamsSchema } from './params';
import { orderForNeed } from './rank';
import {
	NEED_COMPONENT_KEYS,
	needScore,
	type ConfirmedCategory,
	type FspResult,
	type NeedCandidate,
	type NeedScoreInput,
	type NeedSpec,
	type SkillEvidence
} from './score';

const params = matchRulesetParamsSchema.parse(matchRuleset.params);
const NOW = new Date('2026-10-05T12:00:00Z');
const DAY = 86_400_000;

const need = (overrides: Partial<NeedSpec> = {}): NeedSpec => ({
	requiredSkillKeys: ['sql', 'multithreading', 'kafka'],
	niceSkillKeys: ['docker'],
	workFormat: null,
	regionCode: null,
	fspRelevant: true,
	categories: [{ specialization: 'backend', grade: 'middle' }],
	compositeSpecializations: [],
	...overrides
});

/** Backend Middle confirmed by a test: the defining blocks `be.db` (sql, databases) and `be.concurrency`. */
const backendMiddle = (overrides: Partial<ConfirmedCategory> = {}): ConfirmedCategory => ({
	specialization: 'backend',
	grade: 'middle',
	decisionId: 'decision-1',
	confirmedBlocks: ['be.db', 'be.concurrency'],
	confirmedSkillKeys: ['databases', 'multithreading', 'python', 'sql'],
	assignedAt: new Date(NOW.getTime() - 30 * DAY),
	...overrides
});

const skill = (skillKey: string, overrides: Partial<SkillEvidence> = {}): SkillEvidence => ({
	skillKey,
	band: 'strong',
	attestation: 'claimed',
	badgeTrust: 'claimed',
	factIds: [],
	...overrides
});

const candidate = (overrides: Partial<NeedCandidate> = {}): NeedCandidate => ({
	evidence: { status: 'available', runId: 'run', skills: [] },
	categories: [backendMiddle()],
	preferences: { workFormats: [], regionCode: null, relocation: null },
	tests: new Map(),
	lastConfirmedAction: null,
	declared: [],
	fspResults: [],
	...overrides
});

const score = (input: Partial<NeedScoreInput> & Pick<NeedScoreInput, 'candidate'>) =>
	needScore({
		need: need(),
		params: params.need,
		skillBandValue: params.skillBandValue,
		testedSkillValue: params.testedSkillValue,
		now: NOW,
		...input
	});

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** A place of a ranking for a need as `orderForNeed` reads it. */
const place = (
	id: string,
	value: number,
	strength = 0,
	withoutFsp = value,
	unconfirmed = 0,
	without = unconfirmed,
	composite = false
) => ({
	id,
	confirmed: true,
	unconfirmed,
	composite,
	score: value,
	strength,
	withoutFsp: { unconfirmed: without, score: withoutFsp }
});

describe('the fit to a need', () => {
	it('caps what the candidate claims below what the test confirms, lower where their own test checked the skill', () => {
		const claims = (band: SkillEvidence['band'], categories = [backendMiddle({ confirmedSkillKeys: ['python'] })]) =>
			score({
				candidate: candidate({
					categories,
					evidence: {
						status: 'available',
						runId: 'r',
						skills: [skill('sql', { band }), skill('multithreading', { band }), skill('kafka', { band })]
					}
				})
			});
		const claimed = claims('strong');
		const tested = score({ candidate: candidate() });
		// SQL and multithreading the candidate's Backend Middle test checks and did not confirm: their claim is capped low.
		// Kafka no block of that test checks: the resume is the best evidence there is, capped higher, still below a
		// verified public profile.
		const by = (result: ReturnType<typeof score>, key: string) => result.skills.find((s) => s.skill_key === key);
		expect(by(claimed, 'sql')).toMatchObject({ basis: 'claimed', value: params.need.skill.claimedCeiling });
		expect(by(claimed, 'multithreading')).toMatchObject({
			basis: 'claimed',
			value: params.need.skill.claimedCeiling
		});
		expect(by(claimed, 'kafka')).toMatchObject({
			basis: 'claimed_untestable',
			value: params.need.skill.untestableClaimedCeiling
		});
		expect(params.need.skill.claimedCeiling).toBeLessThan(params.need.skill.untestableClaimedCeiling);
		expect(params.need.skill.untestableClaimedCeiling).toBeLessThan(params.need.skill.publicProfileFactor);
		expect(by(tested, 'sql')).toMatchObject({ basis: 'test', value: 1, block: 'be.db' });
		expect(tested.components.required.value).toBeGreaterThan(claimed.components.required.value);
		expect(claimed.toVerify).toEqual(['sql', 'multithreading', 'kafka']);
		// Kafka is in no confirmed stack and not claimed: a gap of the tested candidate.
		expect(tested.gaps).toEqual(['kafka']);

		// The value of a claim follows its band: a weak claim is worth less than a strong one, never the same ceiling.
		const weak = claims('weak');
		expect(by(weak, 'sql')?.value).toBeCloseTo(params.skillBandValue.weak * params.need.skill.claimedCeiling, 6);
		expect(by(weak, 'kafka')?.value).toBeLessThan(by(claimed, 'kafka')?.value ?? 0);
		// Without a category no test of the candidate checked SQL: the claim is capped as an unchecked one.
		expect(by(claims('strong', []), 'sql')).toMatchObject({ basis: 'claimed_untestable' });
	});

	it('tells the coverage of the required skills: confirmed, a public profile, claimed, missing, unknown', () => {
		const tested = score({ candidate: candidate() });
		expect(tested.coverage).toEqual({
			group: 'gaps',
			required: 3,
			unconfirmed: [{ skill_key: 'kafka', state: 'missing' }]
		});
		const fsp = skill('kafka', { attestation: 'direct', badgeTrust: 'fsp_verified', factIds: ['f1'] });
		const covering = score({ candidate: candidate({ evidence: { status: 'available', runId: 'r', skills: [fsp] } }) });
		expect(covering.coverage).toEqual({ group: 'covers', required: 3, unconfirmed: [] });
		const public_ = skill('kafka', { attestation: 'direct', badgeTrust: 'public_verifiable' });
		expect(
			score({ candidate: candidate({ evidence: { status: 'available', runId: 'r', skills: [public_] } }) }).coverage
				.unconfirmed
		).toEqual([{ skill_key: 'kafka', state: 'public_profile' }]);
		expect(
			score({ candidate: candidate({ evidence: { status: 'available', runId: 'r', skills: [skill('kafka')] } }) })
				.coverage.unconfirmed
		).toEqual([{ skill_key: 'kafka', state: 'claimed' }]);
		// A profile that cannot be read now: what the test confirmed stands, the rest is unknown, not missing.
		const unreadable = score({
			candidate: candidate({ evidence: { status: 'unavailable', reason: 'run_below_evidence_floor' } })
		});
		expect(unreadable.coverage.unconfirmed).toEqual([{ skill_key: 'kafka', state: 'unknown' }]);
		expect(unreadable.gaps).toEqual([]);
		// A need without required skills is covered by everybody.
		expect(score({ need: need({ requiredSkillKeys: [] }), candidate: candidate() }).coverage).toEqual({
			group: 'covers',
			required: 0,
			unconfirmed: []
		});
	});

	it('takes the best basis of a skill: a test over a claim, an FSP confirmation by its band', () => {
		const result = score({
			candidate: candidate({
				evidence: {
					status: 'available',
					runId: 'r',
					skills: [
						skill('sql'),
						skill('kafka', { attestation: 'direct', badgeTrust: 'fsp_verified', band: 'moderate', factIds: ['f1'] }),
						skill('docker', { attestation: 'direct', badgeTrust: 'public_verifiable', band: 'strong' })
					]
				}
			})
		});
		const by = (key: string) => result.skills.find((s) => s.skill_key === key);
		expect(by('sql')).toMatchObject({ basis: 'test', value: 1 });
		expect(by('kafka')).toMatchObject({ basis: 'fsp', value: params.skillBandValue.moderate, fact_ids: ['f1'] });
		expect(by('docker')).toMatchObject({ basis: 'public_profile', value: params.need.skill.publicProfileFactor });
	});

	it('adds the levels up with exact contributions over one denominator for the need', () => {
		const result = score({
			need: need({ workFormat: 'remote' }),
			candidate: candidate({ preferences: { workFormats: ['remote'], regionCode: null, relocation: null } })
		});
		const contributions = NEED_COMPONENT_KEYS.map((key) => result.components[key].contribution);
		expect(sum(contributions)).toBeCloseTo(result.score, 3);
		expect(result.levels.need + result.levels.strength).toBeCloseTo(result.score, 3);
		const weights = params.need.weights;
		const denominator = sum(NEED_COMPONENT_KEYS.map((key) => weights[key]));
		expect(result.components.format).toMatchObject({ value: 1, status: 'computed' });
		expect(result.components.format.contribution).toBeCloseTo(weights.format / denominator, 4);
	});

	it('leaves out of every score what the need does not ask for', () => {
		const result = score({
			need: need({ niceSkillKeys: [], fspRelevant: false }),
			candidate: candidate()
		});
		expect(result.components.nice).toMatchObject({ applicable: false, weight: 0, contribution: 0 });
		expect(result.components.format).toMatchObject({ applicable: false, weight: 0 });
		expect(result.components.fsp).toMatchObject({ applicable: false, weight: 0, reason: 'need_fsp_not_relevant' });
	});

	it('does not penalize an unknown format and refuses a format the candidate did not choose', () => {
		const officeInMoscow = need({ workFormat: 'office', regionCode: 'RU-MOW' });
		const of = (preferences: NeedCandidate['preferences']) =>
			score({ need: officeInMoscow, candidate: candidate({ preferences }) }).components.format;
		expect(of({ workFormats: [], regionCode: null, relocation: null })).toMatchObject({
			status: 'unknown',
			value: params.need.format.unknownValue
		});
		expect(of({ workFormats: ['remote'], regionCode: 'RU-MOW', relocation: null }).value).toBe(0);
		expect(of({ workFormats: ['office'], regionCode: 'RU-MOW', relocation: null }).value).toBe(1);
		expect(of({ workFormats: ['office'], regionCode: 'RU-SPE', relocation: true }).value).toBe(
			params.need.format.relocation
		);
		expect(of({ workFormats: ['office'], regionCode: 'RU-SPE', relocation: false }).value).toBe(0);
	});
});

describe('a composite role', () => {
	it('says which specializations of the role the candidate holds a category of', () => {
		const fullstack = need({ compositeSpecializations: ['backend', 'frontend'] });
		const frontendJunior = backendMiddle({ specialization: 'frontend', grade: 'junior', decisionId: 'decision-2' });
		expect(score({ need: fullstack, candidate: candidate() }).composite).toEqual({
			specializations: ['backend', 'frontend'],
			held: ['backend'],
			complete: false
		});
		expect(
			score({ need: fullstack, candidate: candidate({ categories: [backendMiddle(), frontendJunior] }) }).composite
		).toMatchObject({ held: ['backend', 'frontend'], complete: true });
		expect(score({ candidate: candidate() }).composite).toBeNull();
	});
});

describe('the strength of the confirmed profile', () => {
	const results = (blocks: { block: string; items: number; score: number; cut: number }[]) =>
		new Map([['decision-1', blocks]]);

	it('reads the test by blocks: a larger margin is stronger, a block of the need weighs more, a short one less', () => {
		const at = (margin20: number, block = 'be.db', items = 4) =>
			score({
				candidate: candidate({ tests: results([{ block, items, score: 50 + margin20, cut: 50 }]) })
			}).components.test.value;
		expect(at(0)).toBe(0.5);
		expect(at(8)).toBeGreaterThan(at(4));
		expect(at(-4)).toBeLessThan(0.5);
		// The same margin per item counts less on a block of one item than on a block of four.
		expect(at(2, 'be.db', 1)).toBeLessThan(at(8, 'be.db', 4));
		// A block confirming a skill of the need outweighs another block with the same margin.
		const mixed = (related: number, other: number) =>
			score({
				candidate: candidate({
					tests: results([
						{ block: 'be.db', items: 4, score: 50 + related, cut: 50 },
						{ block: 'be.debug', items: 4, score: 50 + other, cut: 50 }
					])
				})
			}).components.test.value;
		expect(mixed(8, -8)).toBeGreaterThan(0.5);
		expect(mixed(-8, 8)).toBeLessThan(0.5);
	});

	it('says when the result cannot be read and counts it at the cut', () => {
		const missing = score({ candidate: candidate() });
		expect(missing.components.test).toMatchObject({
			status: 'unavailable',
			reason: 'test_result_missing',
			value: params.need.test.unknownValue
		});
	});

	describe('the FSP record', () => {
		/** Results of `count` distinct competitions of one discipline — relevant to Backend, by default. */
		const record = (
			count: number,
			podiums = 0,
			team = false,
			discipline: FspResult['discipline'] = 'algorithmic'
		): FspResult[] =>
			Array.from({ length: count }, (_, index) => ({
				factId: `fact-${discipline}-${index}`,
				competitionId: `competition-${discipline}-${index}`,
				discipline,
				podium: index < podiums,
				team
			}));
		const withResults = (fspResults: FspResult[], overrides: Partial<NeedCandidate> = {}) =>
			score({ candidate: candidate({ fspResults, ...overrides }) });

		it('ranks two wins above five participations without a prize, everything else equal', () => {
			const participant = withResults(record(5));
			const winner = withResults(record(2, 2));
			expect(participant.fsp).toEqual({ competitions: 5, podiums: 0, team_podiums: 0, relevant: 5 });
			expect(winner.fsp).toEqual({ competitions: 2, podiums: 2, team_podiums: 0, relevant: 2 });
			expect(winner.components.fsp.value).toBeGreaterThan(participant.components.fsp.value);
			expect(winner.score).toBeGreaterThan(participant.score);
			// One podium outweighs any number of participations; more of either never lowers the record.
			expect(withResults(record(1, 1)).components.fsp.value).toBeGreaterThan(
				withResults(record(50)).components.fsp.value
			);
			expect(withResults(record(6)).components.fsp.value).toBeGreaterThan(participant.components.fsp.value);
			expect(withResults(record(3, 3)).components.fsp.value).toBeGreaterThan(winner.components.fsp.value);
		});

		it('saturates below the test and gives no penalty without FSP', () => {
			const without = withResults([]);
			expect(without.components.fsp).toMatchObject({ value: 0, contribution: 0, reason: 'no_fsp_results' });
			expect(without.fsp).toEqual({ competitions: 0, podiums: 0, team_podiums: 0, relevant: 0 });
			// However long the record, its whole contribution stays under what the test alone can move.
			const champion = withResults(record(40, 40));
			expect(champion.components.fsp.value).toBeLessThanOrEqual(1);
			expect(champion.components.fsp.contribution).toBeLessThan(
				params.need.weights.test / sum(NEED_COMPONENT_KEYS.map((key) => params.need.weights[key])) - 1e-9
			);
			// Without FSP the champion scores like the one who never had it; the reason names the record with its source.
			expect(score({ candidate: candidate({ fspResults: record(40, 40) }), withoutFsp: true }).score).toBe(
				without.score
			);
			expect(champion.reasons.find((reason) => reason.code === 'fsp_record')).toMatchObject({
				competitions: 40,
				podiums: 40,
				source: { kind: 'fsp_fact' }
			});
		});

		it("counts a competition once and a team podium as the team's result, not a confirmed skill", () => {
			const twice: FspResult[] = [
				{ factId: 'a', competitionId: 'c1', discipline: 'algorithmic', podium: false, team: false },
				{ factId: 'b', competitionId: 'c1', discipline: 'algorithmic', podium: true, team: true }
			];
			expect(withResults(twice).fsp).toEqual({ competitions: 1, podiums: 1, team_podiums: 1, relevant: 1 });
			const team = withResults(record(2, 2, true));
			const individual = withResults(record(2, 2));
			expect(team.fsp).toEqual({ competitions: 2, podiums: 2, team_podiums: 2, relevant: 2 });
			expect(team.components.fsp.value).toBe(individual.components.fsp.value);
			// The record confirms no skill: the coverage of the need stays the one of the test.
			expect(team.coverage).toEqual(withResults([]).coverage);
			// The need that says FSP does not matter leaves it out; the catalog without a need counts it.
			expect(
				score({ need: need({ fspRelevant: false }), candidate: candidate({ fspResults: record(2, 2) }) }).fsp
			).toBe(null);
			expect(score({ need: null, candidate: candidate({ fspResults: record(2, 2) }) }).components.fsp.value).toBe(
				individual.components.fsp.value
			);
		});

		it('weighs a competition of a discipline relevant to the specialization above one of another, never zero', () => {
			// Infosec is relevant to Backend, robotics is not: one discipline each, everything else equal.
			const relevant = withResults(record(2, 1, false, 'infosec'));
			const other = withResults(record(2, 1, false, 'robotics'));
			expect(relevant.fsp).toEqual({ competitions: 2, podiums: 1, team_podiums: 0, relevant: 2 });
			expect(other.fsp).toEqual({ competitions: 2, podiums: 1, team_podiums: 0, relevant: 0 });
			expect(relevant.components.fsp.value).toBeGreaterThan(other.components.fsp.value);
			expect(relevant.score).toBeGreaterThan(other.score);
			// Another discipline still counts: a confirmed result, not nothing.
			expect(other.components.fsp.value).toBeGreaterThan(withResults([]).components.fsp.value);
			// Relevance follows the specialization the candidate is ranked in: for a Data/ML need robotics is relevant.
			const dataNeed = need({ categories: [{ specialization: 'data_ml', grade: 'middle' }] });
			expect(
				score({ need: dataNeed, candidate: candidate({ fspResults: record(2, 1, false, 'robotics') }) }).fsp
			).toMatchObject({ relevant: 2 });
			// An unknown discipline is relevant to nothing, and the reason names how many are relevant.
			expect(withResults(record(1, 0, false, 'unknown')).fsp).toMatchObject({ relevant: 0 });
			expect(relevant.reasons.find((reason) => reason.code === 'fsp_record')).toMatchObject({ relevant: 2 });
		});

		it('keeps one podium above any number of participations within each relevance', () => {
			for (const discipline of ['algorithmic', 'robotics'] as const) {
				expect(withResults(record(1, 1, false, discipline)).components.fsp.value).toBeGreaterThan(
					withResults(record(60, 0, false, discipline)).components.fsp.value
				);
			}
			// A podium of another discipline still outweighs any number of relevant participations.
			expect(withResults(record(1, 1, false, 'robotics')).components.fsp.value).toBeGreaterThan(
				withResults(record(60, 0, false, 'algorithmic')).components.fsp.value
			);
			// The rule set refuses a weight of another discipline that would break it.
			const shipped = matchRuleset.params;
			expect(
				matchRulesetParamsSchema.safeParse({
					...shipped,
					need: { ...shipped.need, fsp: { ...shipped.need.fsp, otherDisciplineWeight: 0.2 } }
				}).success
			).toBe(false);
		});
	});

	it('ranks the catalog without a need by the strength alone; without a category the strength is zero', () => {
		const strong = score({ need: null, candidate: candidate() });
		for (const key of ['required', 'nice', 'format'] as const) {
			expect(strong.components[key].applicable).toBe(false);
		}
		expect(strong.levels.need).toBe(0);
		const fresh = score({ need: null, candidate: candidate({ categories: [backendMiddle({ assignedAt: NOW })] }) });
		expect(fresh.components.freshness.value).toBe(1);
		expect(strong.components.freshness.value).toBeLessThan(1);
		const none = score({ need: null, candidate: candidate({ categories: [] }) });
		expect(none.score).toBe(0);
		expect(none.components.test).toMatchObject({ value: 0, reason: 'no_category' });
	});

	it('refreshes the profile by a submitted solution or a block result, not only by the category (domain 13.12)', () => {
		const stale = score({ need: null, candidate: candidate() });
		const solved = score({ need: null, candidate: candidate({ lastConfirmedAction: NOW }) });
		expect(solved.components.freshness.value).toBe(1);
		expect(solved.components.freshness.value).toBeGreaterThan(stale.components.freshness.value);
		// «Подтверждено N дн. назад» names the category only when its assignment is the latest action.
		expect(solved.reasons.some((reason) => reason.code === 'confirmed_recently')).toBe(false);
		const older = score({
			need: null,
			candidate: candidate({ lastConfirmedAction: new Date(NOW.getTime() - 90 * DAY) })
		});
		expect(older.components.freshness.value).toBe(stale.components.freshness.value);
		const withoutAny = score({ need: null, candidate: candidate({ categories: [] }) });
		expect(withoutAny.components.freshness).toMatchObject({ value: 0, reason: 'no_confirmed_action' });
		const onlySolution = score({ need: null, candidate: candidate({ categories: [], lastConfirmedAction: NOW }) });
		expect(onlySolution.components.freshness).toMatchObject({ value: 1, reason: null });
	});
});

describe('the group «грейд не подтверждён»', () => {
	const unconfirmed = (overrides: Partial<NeedCandidate> = {}) =>
		candidate({ categories: [], declared: [{ specialization: 'backend', grade: 'middle' }], ...overrides });

	it("labels the declaration, caps a claim as the declared category's test would, counts FSP as usual", () => {
		const result = score({
			candidate: unconfirmed({
				evidence: {
					status: 'available',
					runId: 'r',
					skills: [
						skill('sql'),
						skill('kafka'),
						skill('docker', { attestation: 'direct', badgeTrust: 'public_verifiable' }),
						skill('multithreading', { attestation: 'direct', badgeTrust: 'fsp_verified', factIds: ['f1'] })
					]
				},
				fspResults: [{ factId: 'f1', competitionId: 'c1', discipline: 'algorithmic', podium: true, team: false }]
			})
		});
		expect(result).toMatchObject({ group: 'unconfirmed', declared: { specialization: 'backend', grade: 'middle' } });
		const by = (key: string) => result.skills.find((s) => s.skill_key === key);
		// The Backend Middle test the candidate declared checks SQL: their claim of it is capped as an unconfirmed check;
		// no block of it checks Kafka.
		expect(by('sql')).toMatchObject({ basis: 'claimed', value: params.need.skill.claimedCeiling });
		expect(by('kafka')).toMatchObject({
			basis: 'claimed_untestable',
			value: params.need.skill.untestableClaimedCeiling
		});
		expect(by('docker')).toMatchObject({ basis: 'public_profile', value: params.need.skill.publicProfileFactor });
		expect(by('multithreading')).toMatchObject({ basis: 'fsp', value: 1 });
		expect(result.toVerify).toEqual(['sql', 'kafka']);
		expect(result.components.test).toMatchObject({ value: 0, reason: 'no_category' });
		expect(result.components.fsp.value).toBeGreaterThan(0);
		// Without the declaration nothing of their own checked SQL.
		const undeclared = score({
			candidate: unconfirmed({ declared: [], evidence: { status: 'available', runId: 'r', skills: [skill('sql')] } })
		});
		expect(undeclared).toMatchObject({ group: 'unconfirmed', declared: null });
		expect(undeclared.skills.find((s) => s.skill_key === 'sql')?.basis).toBe('claimed_untestable');
		expect(score({ candidate: candidate() })).toMatchObject({ group: 'confirmed', declared: null });
	});

	it('puts every confirmed candidate above every unconfirmed one, whatever the scores and the coverage', () => {
		const strong = { ...place('strong', 0.99), confirmed: false };
		const weak = { ...place('weak', 0.1), unconfirmed: 3, withoutFsp: { unconfirmed: 3, score: 0.1 } };
		const order = orderForNeed([strong, weak, { ...place('other', 0.4), confirmed: false }], new Map(), 0.01);
		expect(order.map((p) => p.id)).toEqual(['weak', 'strong', 'other']);
		expect(order.find((p) => p.id === 'strong')).toMatchObject({ position: 2, positionWithoutFsp: 2 });
	});
});

describe('reasons «почему подходит»', () => {
	it('names at most five strongest positive contributions, each with its source', () => {
		const result = score({
			need: need({ workFormat: 'remote' }),
			candidate: candidate({
				preferences: { workFormats: ['remote'], regionCode: null, relocation: null },
				evidence: {
					status: 'available',
					runId: 'r',
					skills: [
						skill('kafka', { attestation: 'direct', badgeTrust: 'fsp_verified', factIds: ['f1'] }),
						skill('docker')
					]
				},
				tests: new Map([['decision-1', [{ block: 'be.db', items: 4, score: 60, cut: 50 }]]])
			})
		});
		expect(result.reasons.length).toBeGreaterThanOrEqual(3);
		expect(result.reasons.length).toBeLessThanOrEqual(5);
		const contributions = result.reasons.map((reason) => reason.contribution);
		expect(contributions).toEqual([...contributions].sort((a, b) => b - a));
		for (const reason of result.reasons) expect(reason.contribution).toBeGreaterThan(0);
		expect(result.reasons[0]).toMatchObject({
			code: 'skills_test',
			skill_keys: ['sql', 'multithreading'],
			source: { kind: 'test_block', ref: 'be.db', specialization: 'backend', grade: 'middle' }
		});
		expect(result.reasons.find((reason) => reason.code === 'skills_fsp')?.source).toEqual({
			kind: 'fsp_fact',
			fact_ids: ['f1']
		});
	});
});

describe('the order of a ranking for a need', () => {
	it('puts those covering every required skill first, then by the number unconfirmed, by score inside', () => {
		const order = orderForNeed(
			[place('a', 0.95, 0, 0.95, 1), place('b', 0.5), place('c', 0.9, 0, 0.9, 2), place('d', 0.6, 0, 0.6, 1)],
			new Map(),
			0.01
		);
		expect(order.map((p) => p.id)).toEqual(['b', 'a', 'd', 'c']);
	});

	it('puts a candidate confirmed in both halves of a composite role first within a group of coverage', () => {
		const order = orderForNeed(
			[
				place('a', 0.9),
				place('b', 0.6, 0, 0.6, 0, 0, true),
				place('c', 0.95, 0, 0.95, 1, 1, true),
				place('d', 0.7, 0, 0.7, 1)
			],
			new Map(),
			0.01
		);
		// Coverage first: `c` with an unconfirmed skill stays below both who cover; inside it the composite one leads.
		expect(order.map((p) => p.id)).toEqual(['b', 'a', 'c', 'd']);
	});

	it('never orders by similarity across the number of unconfirmed skills', () => {
		const order = orderForNeed(
			[place('a', 0.8), place('b', 0.801, 0, 0.801, 1)],
			new Map([
				['a', 0.1],
				['b', 0.9]
			]),
			0.01
		);
		expect(order.map((p) => [p.id, p.tieBrokenBySemantic])).toEqual([
			['a', false],
			['b', false]
		]);
	});

	it('places a candidate whose FSP result confirmed a required skill among the others as without it', () => {
		const order = orderForNeed(
			[place('a', 0.9, 0, 0.85, 0, 1), place('b', 0.6), place('c', 0.8, 0, 0.8, 1), place('d', 0.9, 0, 0.9, 1)],
			new Map(),
			0.01
		);
		// Without FSP `a` leaves the first group: after `b`, and after `d` that covers as much and scores higher.
		expect(order.map((p) => p.id)).toEqual(['a', 'b', 'd', 'c']);
		expect(order.find((p) => p.id === 'a')).toMatchObject({ position: 1, positionWithoutFsp: 3 });
	});

	it('orders almost equal scores by the semantic similarity and never lifts one past a clearly higher score', () => {
		const order = orderForNeed(
			[place('a', 0.8), place('b', 0.795), place('c', 0.792), place('d', 0.7)],
			new Map([
				['b', 0.9],
				['c', 0.1],
				['d', 0.99]
			]),
			0.01
		);
		// `a` has no similarity: it goes after the measured ones of its group; `d` is clearly lower and stays last.
		expect(order.map((p) => p.id)).toEqual(['b', 'c', 'a', 'd']);
		expect(order.slice(0, 3).every((p) => p.tieBrokenBySemantic)).toBe(true);
		expect(order[3]).toMatchObject({ id: 'd', position: 4, tieBrokenBySemantic: false });
	});

	it('without similarities orders almost equal by the strength, then the id', () => {
		const order = orderForNeed([place('a', 0.8, 0.1), place('b', 0.795, 0.3), place('c', 0.5)], new Map(), 0.01);
		expect(order.map((p) => p.id)).toEqual(['b', 'a', 'c']);
		expect(order.every((p) => !p.tieBrokenBySemantic)).toBe(true);
	});

	it('places a candidate without their FSP results among the others as they are', () => {
		const order = orderForNeed(
			[place('a', 0.9, 0, 0.6), place('b', 0.8), place('c', 0.7), place('d', 0.5)],
			new Map(),
			0.01
		);
		expect(order.find((p) => p.id === 'a')).toMatchObject({ position: 1, positionWithoutFsp: 3 });
		expect(order.find((p) => p.id === 'b')).toMatchObject({ position: 2, positionWithoutFsp: 2 });
	});
});
