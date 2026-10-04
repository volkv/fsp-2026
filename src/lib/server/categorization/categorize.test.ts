import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { factClaims, snapshotFacts, type ProjectionTaxonomy } from '$lib/server/fsp/projection';
import type { AchievementsSnapshot, Competition, Qualification, Result } from '$lib/server/fsp/types';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { categorize } from './categorize';
import { aggregateStrength } from './evidence';
import { experienceMonths } from './experience';
import type {
	AssignmentExplanation,
	CategorizationResult,
	CategorizationSnapshot,
	ClaimInput,
	ExperienceInput,
	FactInput,
	RulesContext
} from './types';

const TAXONOMY_DIR = fileURLToPath(new URL('../../../../taxonomy', import.meta.url));
const AS_OF = new Date('2026-09-25T12:00:00Z');

let rules: RulesContext;
let projection: ProjectionTaxonomy;

beforeAll(async () => {
	const datasets = await readTaxonomyDatasets(TAXONOMY_DIR);
	const release = buildRelease(datasets);
	rules = {
		taxonomyVersionId: '00000000-0000-7000-8000-00000000aaaa',
		taxonomyLabel: release.label,
		rulesetId: '00000000-0000-7000-8000-00000000bbbb',
		rulesetVersion: datasets.categorizationRuleset.version,
		params: datasets.categorizationRuleset.params,
		roles: datasets.roles.roles.map((r) => ({
			key: r.key,
			family: r.family,
			coreSkillGroups: r.coreSkillGroups,
			typicalSkills: r.typicalSkills
		})),
		skills: datasets.skills.skills.map((s) => ({ key: s.key, kind: s.kind, parentKey: s.parentKey })),
		grades: datasets.grades.grades.map((g) => ({ key: g.key, ordinal: g.ordinal })),
		fspLevelRules: datasets.fspLevels.levels
	};
	projection = {
		versionId: rules.taxonomyVersionId,
		label: release.label,
		rules: datasets.fspProjection.ruleGroups.flatMap((group, index) =>
			(['skill', 'role', 'marker'] as const).flatMap((kind) =>
				Object.entries(group.targets[kind] ?? {}).map(([targetKey, weight]) => ({
					id: `rule-${index}-${kind}-${targetKey}`,
					discipline: group.discipline,
					targetKind: kind,
					targetKey,
					weight,
					attestation: group.attestation,
					requiresSpecialization: group.requiresSpecialization,
					appliesTo: group.appliesTo
				}))
			)
		),
		strength: {
			evskNorm: datasets.fspStrength.evskNorm,
			rankStrength: datasets.fspStrength.rankStrength,
			formatFactors: datasets.fspStrength.formatFactors,
			unknownRoleFactor: datasets.fspStrength.unknownRoleFactor
		},
		receiptTemplates: new Map()
	};
});

// --- Builders ---------------------------------------------------------------------------------------------------------

let sequence = 0;
const nextId = () => `00000000-0000-7000-8000-${(++sequence).toString(16).padStart(12, '0')}`;

function competition(overrides: Partial<Competition> & { id: string }): Competition {
	return {
		ekpNumber: null,
		title: 'Чемпионат России по спортивному программированию',
		discipline: 'algorithmic',
		level: 'russian_championship',
		stage: 'final',
		ageGroup: 'adults',
		format: 'individual',
		startDate: '2026-03-10',
		online: false,
		...overrides
	};
}

function result(overrides: Partial<Result> & { id: string; competitionId: string }): Result {
	return { place: 2, status: 'official', award: 'prize', ...overrides };
}

interface FspInput {
	competitions?: Competition[];
	results?: Result[];
	qualifications?: Qualification[];
	birthYear?: number;
	nationalTeam?: AchievementsSnapshot['athlete']['nationalTeam'];
}

/** FSP facts and claims exactly as the synchronization writes them. */
function fsp(input: FspInput): { facts: FactInput[]; claims: ClaimInput[] } {
	const snapshot: AchievementsSnapshot = {
		athlete: {
			fspId: 'athlete-1',
			lastName: 'Иванов',
			firstName: 'Иван',
			birthYear: input.birthYear ?? 2003,
			nationalTeam: input.nationalTeam ?? null
		},
		competitions: input.competitions ?? [],
		results: input.results ?? [],
		qualifications: input.qualifications ?? [],
		generatedAt: '2026-09-20T00:00:00Z',
		completeness: { complete: true, sourceVersion: 'v1', pages: { fetched: 1, total: 1 } }
	};
	const facts: FactInput[] = [];
	const claims: ClaimInput[] = [];
	for (const draft of snapshotFacts(snapshot)) {
		const factId = nextId();
		facts.push({
			id: factId,
			source: 'fsp',
			factType: draft.factType,
			sourceRecordRef: draft.sourceRecordRef,
			eventKey: draft.eventKey,
			trustLevel: 'fsp_verified',
			occurredOn: draft.occurredOn,
			payload: draft.payload
		});
		for (const claim of factClaims(draft, snapshot.athlete.birthYear, projection)) {
			claims.push({
				id: nextId(),
				factId,
				claimType: claim.claimType,
				extractor: 'source_mapping',
				skillKey: claim.skillKey,
				eventKey: null,
				polarity: 'asserted',
				candidateReview: 'pending',
				experienceEntryId: null,
				value: claim.value
			});
		}
	}
	return { facts, claims };
}

interface ResumeInput {
	mentions?: { skill: string; polarity?: ClaimInput['polarity']; eventKey?: string }[];
	markers?: string[];
	entries?: Partial<ExperienceInput>[];
}

function resume(input: ResumeInput): { facts: FactInput[]; claims: ClaimInput[]; experience: ExperienceInput[] } {
	const factId = nextId();
	const fact: FactInput = {
		id: factId,
		source: 'resume',
		factType: 'resume_document',
		sourceRecordRef: `resume:${nextId()}`,
		eventKey: null,
		trustLevel: 'claimed',
		occurredOn: null,
		payload: {}
	};
	const claim = (overrides: Partial<ClaimInput>): ClaimInput => ({
		id: nextId(),
		factId,
		claimType: 'skill_mention',
		extractor: 'model',
		skillKey: null,
		eventKey: null,
		polarity: 'asserted',
		candidateReview: 'confirmed',
		experienceEntryId: null,
		value: null,
		...overrides
	});
	return {
		facts: [fact],
		claims: [
			...(input.mentions ?? []).map((m) =>
				claim({ skillKey: m.skill, polarity: m.polarity ?? 'asserted', eventKey: m.eventKey ?? null })
			),
			...(input.markers ?? []).map((marker) => claim({ claimType: 'responsibility_marker', value: { marker } }))
		],
		experience: (input.entries ?? []).map((e) => ({
			id: nextId(),
			factId,
			roleKey: 'backend',
			periodFrom: '2020-01-01',
			periodTo: null,
			periodFromPrecision: 'month',
			periodToPrecision: null,
			isCurrent: true,
			appliedSkillKeys: [],
			periodStatus: 'valid',
			candidateReview: 'confirmed',
			...e
		}))
	};
}

function snapshotOf(
	...parts: { facts: FactInput[]; claims: ClaimInput[]; experience?: ExperienceInput[] }[]
): CategorizationSnapshot {
	return {
		candidateId: '00000000-0000-7000-8000-0000000000c1',
		revision: 1,
		desiredRoleKeys: [],
		facts: parts.flatMap((p) => p.facts),
		claims: parts.flatMap((p) => p.claims),
		experience: parts.flatMap((p) => p.experience ?? [])
	};
}

const inference = (result: CategorizationResult, skill: string) => result.inferences.find((i) => i.skillKey === skill);
const LANGUAGES = () => new Set(rules.skills.filter((s) => s.kind === 'language').map((s) => s.key));

function primaryExplanation(result: CategorizationResult): AssignmentExplanation {
	const primary = result.assignments[0];
	if (!primary) throw new Error('no primary assignment');
	return primary.explanation;
}

// --- Scenarios ----------------------------------------------------------------------------------------------------------

describe('olympiad participant without commercial experience', () => {
	it('gets the FSP level and confirmed skills, but neither a role nor a grade', () => {
		const final = competition({ id: 'rc-2026' });
		const input = fsp({
			competitions: [final],
			results: [result({ id: 'r1', competitionId: final.id, place: 2 })],
			qualifications: [
				{ id: 'q1', rank: 'KMS', discipline: 'algorithmic', assignedAt: '2026-05-01', basisCompetitionId: final.id }
			]
		});
		const result_ = categorize(snapshotOf(input), rules, AS_OF);

		expect(result_.outcome).toBe('partial');
		const primary = result_.assignments[0];
		expect(result_.assignments).toHaveLength(1);
		expect(primary).toMatchObject({
			rank: 'primary',
			roleStatus: 'insufficient_data',
			roleKey: null,
			gradeStatus: 'insufficient_data',
			gradeMin: null,
			gradeMax: null,
			stackStatus: 'established'
		});
		// Findable by the FSP level facet and by the confirmed skills, not by an invented role or grade.
		expect(primary?.stackSkillKeys).toContain('algorithms');
		expect(result_.missing.grade).toEqual([{ code: 'no_dated_experience' }]);
		expect(result_.fspLevels).toEqual([
			expect.objectContaining({ discipline: 'algorithmic', level: 'L4', lastResultOn: '2026-03-10' })
		]);
		expect(inference(result_, 'algorithms')).toMatchObject({ attestation: 'direct', badgeTrust: 'fsp_verified' });
		// A result proves no programming language.
		expect(result_.inferences.filter((i) => LANGUAGES().has(i.skillKey))).toEqual([]);
		expect(primaryExplanation(result_).grade.ignored).toEqual([
			{ code: 'fsp_does_not_set_grade', fact_ids: input.facts.map((f) => f.id).sort() }
		]);
	});

	it('gets no role from an algorithmic result even with a language in the resume', () => {
		const final = competition({ id: 'rc-lang' });
		const achievements = fsp({
			competitions: [final],
			results: [result({ id: 'r-lang', competitionId: final.id, place: 2 })],
			qualifications: [
				{ id: 'q-lang', rank: 'KMS', discipline: 'algorithmic', assignedAt: '2026-05-01', basisCompetitionId: final.id }
			]
		});
		const line = resume({ mentions: [{ skill: 'python' }] });
		const result_ = categorize(snapshotOf(achievements, line), rules, AS_OF);

		// The rank confirms algorithms; the work of an algorithm engineer needs grounds outside FSP.
		expect(inference(result_, 'algorithms')).toMatchObject({ band: 'strong', badgeTrust: 'fsp_verified' });
		expect(result_.assignments.map((a) => a.roleKey)).toEqual([null]);
		expect(result_.missing.role).toContainEqual(
			expect.objectContaining({ code: 'role_below_threshold', role_key: 'algo_engineer' })
		);
	});
});

describe('FSP as a supporting ground of a role', () => {
	const analyst = () =>
		resume({
			entries: [{ roleKey: 'data_analyst', periodFrom: '2019-01-01', appliedSkillKeys: ['sql', 'python', 'pandas'] }]
		});

	it('keeps the role and grade of a senior analyst with an algorithmic rank', () => {
		const achievements = fsp({
			qualifications: [{ id: 'q-ii', rank: 'II', discipline: 'algorithmic', assignedAt: '2025-04-01' }]
		});
		const without = categorize(snapshotOf(analyst()), rules, AS_OF);
		const withFsp = categorize(snapshotOf(analyst(), achievements), rules, AS_OF);

		expect(without.assignments[0]).toMatchObject({ roleKey: 'data_analyst', gradeMin: 'senior' });
		expect(withFsp.assignments.map((a) => a.roleKey)).toEqual(['data_analyst']);
		expect(withFsp.assignments[0]).toMatchObject({
			gradeMin: without.assignments[0]?.gradeMin,
			gradeMax: without.assignments[0]?.gradeMax
		});
		expect(withFsp.fspLevels).toEqual([expect.objectContaining({ discipline: 'algorithmic', level: 'L2' })]);
	});

	it('never makes a role primary over one established without FSP, whatever its score', () => {
		const hackathon = competition({ id: 'product-kms', discipline: 'product', format: 'team' });
		const achievements = fsp({
			competitions: [hackathon],
			results: [
				result({
					id: 'r-backend',
					competitionId: hackathon.id,
					place: 1,
					evskFulfilled: 'KMS',
					team: { id: 't-b', name: 'Команда', role: 'athlete', specialization: 'backend' }
				})
			]
		});
		const result_ = categorize(snapshotOf(analyst(), achievements), rules, AS_OF);
		const [primary, secondary] = result_.assignments;

		expect(primary).toMatchObject({ rank: 'primary', roleKey: 'data_analyst', gradeMin: 'senior' });
		expect(secondary).toMatchObject({ rank: 'secondary', roleKey: 'backend', gradeStatus: 'insufficient_data' });
		// The specialization adds up to more than the analyst's own grounds, yet only supports the role.
		expect(secondary?.score ?? 0).toBeGreaterThan(primary?.score ?? 1);
		const role = (a: typeof primary) => a?.explanation.role;
		expect(role(primary)).toMatchObject({ established_without_fsp: true });
		expect(role(secondary)).toMatchObject({ established_without_fsp: false });
	});

	it('establishes a role named by a specialization when nothing else speaks of the role', () => {
		const hackathon = competition({ id: 'product-front', discipline: 'product', format: 'team' });
		const achievements = fsp({
			competitions: [hackathon],
			results: [
				result({
					id: 'r-front',
					competitionId: hackathon.id,
					place: 1,
					evskFulfilled: 'KMS',
					team: { id: 't-f', name: 'Команда', role: 'athlete', specialization: 'frontend' }
				})
			]
		});
		const result_ = categorize(snapshotOf(achievements), rules, AS_OF);
		expect(result_.assignments[0]).toMatchObject({
			roleStatus: 'established',
			roleKey: 'frontend',
			gradeStatus: 'insufficient_data'
		});
		expect(result_.assignments[0]?.explanation.role).toMatchObject({ established_without_fsp: false });
	});

	it('leaves a single participation without a rank to the FSP level facet, not to a role', () => {
		const hackathon = competition({
			id: 'product-once',
			discipline: 'product',
			format: 'team',
			level: 'unknown',
			online: true
		});
		const achievements = fsp({
			competitions: [hackathon],
			results: [
				result({
					id: 'r-once',
					competitionId: hackathon.id,
					place: 14,
					award: 'participant',
					team: { id: 't-o', name: 'Команда', role: 'athlete', specialization: 'backend' }
				})
			]
		});
		const student = resume({ mentions: [{ skill: 'python' }, { skill: 'sql' }] });
		const result_ = categorize({ ...snapshotOf(student, achievements), desiredRoleKeys: ['backend'] }, rules, AS_OF);

		expect(result_.assignments.filter((a) => a.roleStatus === 'established')).toEqual([]);
		expect(result_.fspLevels).toEqual([expect.objectContaining({ discipline: 'product', level: 'L1' })]);
		const desired = result_.missing.role.find((m) => m.code === 'desired_role_not_inferred');
		expect(desired).toMatchObject({ role_key: 'backend', known_role: true });
		expect(desired?.score).toBeLessThan(rules.params.role.minScore);
	});
});

describe('senior without FSP achievements', () => {
	it('gets a complete category from the resume alone', () => {
		const input = resume({
			mentions: [{ skill: 'go' }, { skill: 'docker' }, { skill: 'kafka' }],
			entries: [
				{ periodFrom: '2018-03-01', appliedSkillKeys: ['go', 'sql', 'postgresql'] },
				{
					roleKey: 'backend',
					periodFrom: '2016-01-01',
					periodTo: '2018-02-01',
					periodToPrecision: 'month',
					isCurrent: false,
					appliedSkillKeys: ['python', 'sql']
				}
			]
		});
		const result_ = categorize(snapshotOf(input), rules, AS_OF);

		expect(result_.outcome).toBe('complete');
		expect(result_.assignments[0]).toMatchObject({
			roleKey: 'backend',
			gradeStatus: 'established',
			gradeMin: 'senior',
			gradeMax: 'senior',
			gradeConfidence: 0.7,
			stackStatus: 'established'
		});
		// Core skills of the role first, then typical ones.
		expect(result_.assignments[0]?.stackSkillKeys).toEqual(['go', 'python', 'sql']);
		expect(result_.fspLevels).toEqual([]);
		expect(result_.missing).toEqual({ role: [], grade: [], stack: [] });
		// The next grade is tied to concrete requirements: a responsibility marker and a level test for «lead».
		expect(primaryExplanation(result_).grade.next_grade).toMatchObject({
			target: 'lead',
			requirements: expect.arrayContaining([
				expect.objectContaining({ code: 'responsibility_marker' }),
				{ code: 'level_test', grade: 'lead' }
			]) as unknown
		});
		expect(inference(result_, 'go')).toMatchObject({ attestation: 'claimed', badgeTrust: null });
	});
});

describe('FSP never sets or shifts a grade', () => {
	it('keeps the grade of the production signals whatever the FSP achievements', () => {
		const work = resume({
			mentions: [{ skill: 'python' }],
			entries: [{ periodFrom: '2025-06-01', appliedSkillKeys: ['python', 'sql'] }]
		});
		const final = competition({ id: 'wc-2026', level: 'world_championship', format: 'team' });
		const achievements = fsp({
			competitions: [final],
			results: [
				result({
					id: 'r-world',
					competitionId: final.id,
					place: 1,
					team: { id: 't1', name: 'Команда', role: 'captain', specialization: null }
				})
			],
			qualifications: [{ id: 'q-ms', rank: 'MS', discipline: 'algorithmic', assignedAt: '2026-06-01' }]
		});
		const without = categorize(snapshotOf(work), rules, AS_OF);
		const withFsp = categorize(snapshotOf(work, achievements), rules, AS_OF);
		const backend = (r: CategorizationResult) => r.assignments.find((a) => a.roleKey === 'backend');

		expect(backend(without)).toMatchObject({ gradeMin: 'junior', gradeMax: 'middle' });
		expect(backend(withFsp)).toMatchObject({
			gradeStatus: backend(without)?.gradeStatus,
			gradeMin: backend(without)?.gradeMin,
			gradeMax: backend(without)?.gradeMax,
			gradeConfidence: backend(without)?.gradeConfidence
		});
		// The captain marker is shown, never used as a grade signal.
		const explanation = backend(withFsp)?.explanation;
		expect(explanation?.fsp_markers).toEqual([expect.objectContaining({ marker: 'team_lead' })]);
		expect(explanation?.grade.signals.map((s) => s.signal)).toEqual(['role_experience']);
	});
});

describe('team prize winner without a personal specialization', () => {
	it('confirms neither a language nor teamwork directly', () => {
		const hackathon = competition({ id: 'product-2026', discipline: 'product', format: 'team' });
		const input = fsp({
			competitions: [hackathon],
			results: [
				result({
					id: 'r-team',
					competitionId: hackathon.id,
					place: 1,
					team: { id: 't2', name: 'Команда', role: 'athlete', specialization: null }
				})
			]
		});
		const result_ = categorize(snapshotOf(input), rules, AS_OF);

		expect(result_.inferences.filter((i) => LANGUAGES().has(i.skillKey))).toEqual([]);
		expect(inference(result_, 'teamwork')).toMatchObject({ attestation: 'derived', badgeTrust: null });
		expect(inference(result_, 'teamwork')?.contributions[0]).toMatchObject({ team_factor: 0.7 });
		expect(result_.inferences.every((i) => i.badgeTrust === null)).toBe(true);
		expect(result_.outcome).toBe('insufficient_data');
		expect(result_.assignments).toEqual([]);
		expect(result_.missing.role).toEqual([{ code: 'no_role_evidence' }]);
		expect(result_.fspLevels).toEqual([expect.objectContaining({ discipline: 'product' })]);
	});

	it('in a team algorithmic final gets algorithms only as derived', () => {
		const icpc = competition({ id: 'icpc-2026', format: 'team' });
		const input = fsp({
			competitions: [icpc],
			results: [
				result({ id: 'r-icpc', competitionId: icpc.id, team: { id: 't3', name: 'Команда', specialization: null } })
			]
		});
		const result_ = categorize(snapshotOf(input), rules, AS_OF);
		expect(inference(result_, 'algorithms')).toMatchObject({ attestation: 'derived', badgeTrust: null });
		expect(result_.inferences.filter((i) => LANGUAGES().has(i.skillKey))).toEqual([]);
	});
});

describe('groups of dependent evidence', () => {
	it('counts one event from three sources once: the largest contribution', () => {
		const final = competition({ id: 'rc-2025', startDate: '2025-10-01' });
		const achievements = fsp({
			competitions: [final],
			results: [result({ id: 'r2', competitionId: final.id, place: 3 })],
			qualifications: [
				{ id: 'q2', rank: 'KMS', discipline: 'algorithmic', assignedAt: '2026-01-15', basisCompetitionId: final.id }
			]
		});
		const line = resume({ mentions: [{ skill: 'algorithms', eventKey: `fsp:competition:${final.id}` }] });
		const result_ = categorize(snapshotOf(achievements, line), rules, AS_OF);
		const algorithms = inference(result_, 'algorithms');
		const own = algorithms?.contributions.filter((c) => c.via_skill === null) ?? [];

		expect(new Set(own.map((c) => c.basis))).toEqual(new Set(['fsp_projection', 'resume_mention']));
		expect(new Set(own.map((c) => c.group_key))).toEqual(new Set([`fsp:competition:${final.id}`]));
		expect(own).toHaveLength(3);
		expect(algorithms?.strength).toBe(Number(Math.max(...own.map((c) => c.contribution)).toFixed(3)));
	});

	it('counts results of different competitions as separate groups', () => {
		const first = competition({ id: 'reg-2026', level: 'regional_championship' });
		const second = competition({ id: 'fd-2026', level: 'federal_district' });
		const input = fsp({
			competitions: [first, second],
			results: [
				result({ id: 'a', competitionId: first.id, place: 1 }),
				result({ id: 'b', competitionId: second.id, place: 1 })
			]
		});
		const algorithms = inference(categorize(snapshotOf(input), rules, AS_OF), 'algorithms');
		const own = algorithms?.contributions.filter((c) => c.via_skill === null) ?? [];
		const contributions = own.map((c) => c.contribution);
		expect(new Set(own.map((c) => c.group_key)).size).toBe(2);
		expect(algorithms?.strength).toBeGreaterThan(Math.max(...contributions));
	});

	it('aggregates within a group by maximum and across groups by saturation', () => {
		const c = (group_key: string, contribution: number) => ({ group_key, contribution }) as never;
		expect(aggregateStrength([c('g', 0.6), c('g', 0.5), c('g', 0.4)])).toBeCloseTo(0.6, 10);
		expect(aggregateStrength([c('g1', 0.6), c('g2', 0.5)])).toBeCloseTo(0.8, 10);
	});
});

describe('format of the competition', () => {
	it('weighs an online qualifier less than an on-site final', () => {
		const qualifier = competition({ id: 'q-online', stage: 'qualifier', online: true });
		const final = competition({ id: 'f-onsite', stage: 'final', online: false });
		const contributionOf = (c: Competition) => {
			const input = fsp({
				competitions: [c],
				results: [result({ id: `r-${c.id}`, competitionId: c.id, evskFulfilled: 'KMS' })]
			});
			const own = inference(categorize(snapshotOf(input), rules, AS_OF), 'algorithms')?.contributions[0];
			if (!own) throw new Error('no contribution');
			return own;
		};
		const online = contributionOf(qualifier);
		const onsite = contributionOf(final);
		expect(online.strength_of_result).toBe(onsite.strength_of_result);
		expect(online.format_factor).toBeLessThan(onsite.format_factor ?? 0);
		expect(online.contribution).toBeLessThan(onsite.contribution);
	});
});

describe('rule set versions and determinism', () => {
	it('gives the same result for the same snapshot, rules and as_of', () => {
		const final = competition({ id: 'rc-det' });
		const input = snapshotOf(
			fsp({ competitions: [final], results: [result({ id: 'r-det', competitionId: final.id })] }),
			resume({ mentions: [{ skill: 'cpp' }], entries: [{ periodFrom: '2024-01-01', appliedSkillKeys: ['cpp'] }] })
		);
		expect(categorize(input, rules, AS_OF)).toEqual(categorize(structuredClone(input), rules, AS_OF));
	});

	it('computes another result under another rule set version', () => {
		const input = snapshotOf(resume({ entries: [{ periodFrom: '2023-01-01', appliedSkillKeys: ['go', 'sql'] }] }));
		const stricter: RulesContext = {
			...rules,
			rulesetId: '00000000-0000-7000-8000-00000000cccc',
			rulesetVersion: rules.rulesetVersion + 1,
			params: { ...rules.params, role: { ...rules.params.role, minScore: 0.9 } }
		};
		const before = categorize(input, rules, AS_OF);
		const after = categorize(input, stricter, AS_OF);
		expect(before.assignments[0]).toMatchObject({ roleKey: 'backend', roleStatus: 'established' });
		expect(after.assignments[0]?.roleStatus).toBe('insufficient_data');
		expect(after.assignments[0]?.explanation.ruleset_version).toBe(rules.rulesetVersion + 1);
	});
});

describe('resume evidence', () => {
	it('gives no inference from a negated mention', () => {
		const input = resume({
			mentions: [
				{ skill: 'go', polarity: 'negated' },
				{ skill: 'rust', polarity: 'uncertain' }
			]
		});
		const result_ = categorize(snapshotOf(input), rules, AS_OF);
		expect(inference(result_, 'go')).toBeUndefined();
		expect(inference(result_, 'rust')).toBeUndefined();
		expect(result_.unused.map((u) => u.code).sort()).toEqual(['polarity_negated', 'polarity_uncertain']);
	});

	it('counts mentions of one resume as one self-declaration', () => {
		const input = resume({
			mentions: [{ skill: 'go' }, { skill: 'go' }],
			entries: [
				{
					periodFrom: '2020-01-01',
					periodTo: '2021-01-01',
					periodToPrecision: 'month',
					isCurrent: false,
					appliedSkillKeys: ['go']
				},
				{ periodFrom: '2022-01-01', appliedSkillKeys: ['go'] }
			]
		});
		const go = inference(categorize(snapshotOf(input), rules, AS_OF), 'go');
		expect(go?.contributions).toHaveLength(4);
		expect(go?.strength).toBe(rules.params.evidence.claimWeights.resumeAppliedSkill);
	});

	it('passes a partial derived contribution from a framework to its language', () => {
		const result_ = categorize(snapshotOf(resume({ mentions: [{ skill: 'spring_boot' }] })), rules, AS_OF);
		expect(inference(result_, 'spring')?.strength).toBe(0.15);
		expect(inference(result_, 'java')).toMatchObject({ strength: 0.075, attestation: 'derived' });
	});
});

describe('public profile evidence', () => {
	function codeforces(payload: { rating: number | null; maxRating: number | null; solvedCount: number }) {
		return {
			facts: [
				{
					id: nextId(),
					source: 'codeforces' as const,
					factType: 'platform_rating',
					sourceRecordRef: 'codeforces:user:solver',
					eventKey: 'profile:codeforces:solver',
					trustLevel: 'public_verifiable' as const,
					occurredOn: '2026-09-12',
					payload: {
						account: { platform: 'codeforces', login: 'Solver', rating: payload.rating },
						maxRating: payload.maxRating,
						rank: null,
						maxRank: null,
						solvedCount: payload.solvedCount,
						ratedContests: 20,
						lastRatedOn: '2026-09-12',
						registeredOn: '2020-01-01'
					}
				}
			],
			claims: []
		};
	}

	function github(languages: { name: string; share: number }[], trustLevel: 'public_verifiable' | 'claimed') {
		return {
			facts: [
				{
					id: nextId(),
					source: 'github' as const,
					factType: 'repo_languages',
					sourceRecordRef: 'github:user:42',
					eventKey: 'profile:github:dev',
					trustLevel,
					occurredOn: '2026-09-01',
					payload: { login: 'dev', languages: languages.map((l) => ({ ...l, repos: 1 })) }
				}
			],
			claims: []
		};
	}

	it('confirms the skills of competitive programming by the peak Codeforces rating, badge «public profile»', () => {
		const rule = rules.params.evidence.publicProfiles.codeforces;
		const result_ = categorize(
			snapshotOf(codeforces({ rating: 1700, maxRating: 1950, solvedCount: 300 })),
			rules,
			AS_OF
		);
		for (const skill of rule.skills) {
			const found = inference(result_, skill);
			expect(found).toMatchObject({ attestation: 'direct', badgeTrust: 'public_verifiable' });
			expect(found?.contributions[0]).toMatchObject({
				basis: 'public_profile',
				source: 'codeforces',
				trust_level: 'public_verifiable',
				strength_of_result: 0.8
			});
		}
		// A higher peak is stronger; too few solved problems confirm nothing.
		const stronger = categorize(
			snapshotOf(codeforces({ rating: 2500, maxRating: 2500, solvedCount: 900 })),
			rules,
			AS_OF
		);
		expect(inference(stronger, 'algorithms')?.strength ?? 0).toBeGreaterThan(
			inference(result_, 'algorithms')?.strength ?? 1
		);
		const idle = categorize(snapshotOf(codeforces({ rating: 1900, maxRating: 1900, solvedCount: 3 })), rules, AS_OF);
		expect(inference(idle, 'algorithms')).toBeUndefined();
		expect(idle.unused.map((u) => u.code)).toContain('too_few_solved');
	});

	it('confirms a GitHub language above its share, weaker than a platform test of it', () => {
		const result_ = categorize(
			snapshotOf(
				github(
					[
						{ name: 'C++', share: 0.6 },
						{ name: 'Python', share: 0.35 },
						{ name: 'Shell', share: 0.05 }
					],
					'public_verifiable'
				)
			),
			rules,
			AS_OF
		);
		const cpp = inference(result_, 'cpp');
		expect(cpp).toMatchObject({ attestation: 'direct', badgeTrust: 'public_verifiable' });
		expect(cpp?.strength ?? 1).toBeLessThan(rules.params.evidence.claimWeights.platformTest);
		expect(inference(result_, 'python')?.strength ?? 1).toBeLessThan(cpp?.strength ?? 0);
		// Below the minimum share a language confirms nothing.
		expect(inference(result_, 'bash')).toBeUndefined();
	});

	it('gives no badge from a profile whose ownership is not verified', () => {
		const result_ = categorize(snapshotOf(github([{ name: 'Go', share: 0.9 }], 'claimed')), rules, AS_OF);
		expect(inference(result_, 'go')).toMatchObject({ attestation: 'claimed', badgeTrust: null });
	});
});

describe('desired role', () => {
	it('is shown against the inferred role and changes no axis', () => {
		const input = snapshotOf(resume({ entries: [{ periodFrom: '2022-01-01', appliedSkillKeys: ['go', 'sql'] }] }));
		const plain = categorize(input, rules, AS_OF);
		const desiring = categorize({ ...input, desiredRoleKeys: ['frontend'] }, rules, AS_OF);
		const axes = (r: CategorizationResult) =>
			r.assignments.map((a) => [a.roleKey, a.gradeMin, a.gradeMax, a.gradeConfidence, a.stackSkillKeys]);
		expect(axes(desiring)).toEqual(axes(plain));
		expect(primaryExplanation(desiring).desired_roles).toEqual([
			expect.objectContaining({
				role_key: 'frontend',
				status: 'not_inferred',
				unconfirmed_core_groups: [['javascript', 'typescript'], ['html'], ['css']]
			})
		]);
	});
});

describe('grade signals', () => {
	it('lets a level test cap the upper end and shows a disagreement below the range', () => {
		const work = resume({ entries: [{ periodFrom: '2021-01-01', appliedSkillKeys: ['go', 'sql'] }] });
		const test = (gradeKey: string) => ({
			facts: [
				{
					id: nextId(),
					source: 'platform_test' as const,
					factType: 'test_score',
					sourceRecordRef: `test:score:${nextId()}`,
					eventKey: 'test:assessment:go-level',
					trustLevel: 'platform_verified' as const,
					occurredOn: '2026-09-01',
					payload: { assessmentId: 'go-level', skillKeys: ['go'], levelStrength: 0.8, gradeKey }
				}
			],
			claims: []
		});
		const base = categorize(snapshotOf(work), rules, AS_OF).assignments[0];
		expect(base).toMatchObject({ gradeMin: 'middle', gradeMax: 'senior' });

		const capped = categorize(snapshotOf(work, test('middle')), rules, AS_OF).assignments[0];
		expect(capped).toMatchObject({ gradeMin: 'middle', gradeMax: 'middle' });
		expect((capped?.gradeConfidence ?? 0) > (base?.gradeConfidence ?? 0)).toBe(true);

		const below = categorize(snapshotOf(work, test('junior')), rules, AS_OF).assignments[0];
		expect(below).toMatchObject({ gradeMin: 'middle', gradeMax: 'middle' });
		expect(below?.explanation.grade.disagreements).toEqual([
			{ source: 'role_experience', grade_min: 'middle', grade_max: 'senior' },
			expect.objectContaining({ source: 'level_test', grade_min: 'junior', grade_max: 'junior' })
		]);
		expect(inference(categorize(snapshotOf(work, test('middle')), rules, AS_OF), 'go')).toMatchObject({
			attestation: 'direct',
			badgeTrust: 'platform_verified'
		});
	});

	it('raises the upper end by a resume responsibility marker', () => {
		const work = resume({
			markers: ['mentoring'],
			entries: [{ periodFrom: '2018-01-01', appliedSkillKeys: ['go', 'sql'] }]
		});
		expect(categorize(snapshotOf(work), rules, AS_OF).assignments[0]).toMatchObject({
			gradeMin: 'senior',
			gradeMax: 'lead'
		});
	});

	it('lists entries without valid dates as missing grounds of the grade', () => {
		const work = resume({
			entries: [{ periodFrom: null, periodFromPrecision: null, isCurrent: false, periodStatus: 'missing' }]
		});
		const result_ = categorize(snapshotOf(work), rules, AS_OF);
		expect(result_.missing.grade).toEqual([
			{ code: 'no_dated_experience' },
			{ code: 'experience_period_missing', experience_entry_id: work.experience[0]?.id }
		]);
	});
});

describe('experience length', () => {
	const entry = (overrides: Partial<ExperienceInput>): ExperienceInput => ({
		id: nextId(),
		factId: 'f',
		roleKey: 'backend',
		periodFrom: '2020-01-01',
		periodTo: '2022-01-01',
		periodFromPrecision: 'month',
		periodToPrecision: 'month',
		isCurrent: false,
		appliedSkillKeys: [],
		periodStatus: 'valid',
		candidateReview: 'confirmed',
		...overrides
	});

	it('merges parallel jobs instead of summing them', () => {
		const months = experienceMonths(
			[entry({ periodTo: '2021-12-01' }), entry({ periodFrom: '2021-01-01', periodTo: '2022-12-01' })],
			AS_OF
		);
		expect(months).toEqual({ min_months: 36, max_months: 36 });
	});

	it('gives a range for periods known only to the year', () => {
		const months = experienceMonths(
			[entry({ periodFromPrecision: 'year', periodTo: '2022-01-01', periodToPrecision: 'year' })],
			AS_OF
		);
		expect(months).toEqual({ min_months: 14, max_months: 36 });
	});
});
