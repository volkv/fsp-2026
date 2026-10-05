// Ranking for a hiring need (docs/domain.md, section 13.10): candidates covering every required skill come first, then
// by the number of unconfirmed ones — missing, unknown and claimed told apart; what a candidate says of themselves is
// worth its band under a ceiling below what a check confirms, the two levels add up with exact contributions, FSP is a
// bonus only where it relates to the need and never a penalty, the test is read by blocks, and the semantic similarity
// only orders almost equal scores.
import { describe, expect, it } from 'vitest';
import matchRuleset from '../../../../taxonomy/match-ruleset.json';
import { matchRulesetParamsSchema } from './params';
import { orderForNeed } from './rank';
import {
	NEED_COMPONENT_KEYS,
	needScore,
	type ConfirmedCategory,
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
	...overrides
});

const score = (input: Partial<NeedScoreInput> & Pick<NeedScoreInput, 'candidate'>) =>
	needScore({ need: need(), params: params.need, skillBandValue: params.skillBandValue, now: NOW, ...input });

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

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

	it('gives FSP a bonus only where it confirms a skill of the need, and no penalty without it', () => {
		const related = skill('kafka', { attestation: 'direct', badgeTrust: 'fsp_verified', factIds: ['f1'] });
		const unrelated = skill('algorithms', { attestation: 'direct', badgeTrust: 'fsp_verified', factIds: ['f2'] });
		const evidence = (skills: SkillEvidence[]) => ({ status: 'available' as const, runId: 'r', skills });
		const without = score({ candidate: candidate() });
		const withUnrelated = score({ candidate: candidate({ evidence: evidence([unrelated]) }) });
		const withRelated = score({ candidate: candidate({ evidence: evidence([related]) }) });
		expect(without.components.fsp).toMatchObject({ value: 0, contribution: 0, reason: 'no_related_fsp' });
		expect(withUnrelated.score).toBe(without.score);
		expect(withRelated.components.fsp.value).toBe(1);
		expect(withRelated.score).toBeGreaterThan(without.score);
		// Without FSP the related candidate scores like the one who never had it.
		const asIfWithout = score({ candidate: candidate({ evidence: evidence([related]) }), withoutFsp: true });
		expect(asIfWithout.score).toBe(without.score);
		// The catalog without a need counts any FSP result.
		expect(score({ need: null, candidate: candidate({ evidence: evidence([unrelated]) }) }).components.fsp.value).toBe(
			1
		);
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
	const place = (
		id: string,
		score: number,
		strength = 0,
		withoutFsp = score,
		unconfirmed = 0,
		without = unconfirmed
	) => ({
		id,
		unconfirmed,
		score,
		strength,
		withoutFsp: { unconfirmed: without, score: withoutFsp }
	});

	it('puts those covering every required skill first, then by the number unconfirmed, by score inside', () => {
		const order = orderForNeed(
			[place('a', 0.95, 0, 0.95, 1), place('b', 0.5), place('c', 0.9, 0, 0.9, 2), place('d', 0.6, 0, 0.6, 1)],
			new Map(),
			0.01
		);
		expect(order.map((p) => p.id)).toEqual(['b', 'a', 'd', 'c']);
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
