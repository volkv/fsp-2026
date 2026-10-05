import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { factClaims, snapshotFacts, type ProjectionTaxonomy } from '$lib/server/fsp/projection';
import type { AchievementsSnapshot, Competition, Qualification, Result } from '$lib/server/fsp/types';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { computeEvidence } from './compute';
import { experienceMonths } from './experience';
import { aggregateStrength } from './inferences';
import type { ClaimInput, EvidenceResult, EvidenceSnapshot, ExperienceInput, FactInput, RulesContext } from './types';

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
): EvidenceSnapshot {
	return {
		candidateId: '00000000-0000-7000-8000-0000000000c1',
		revision: 1,
		facts: parts.flatMap((p) => p.facts),
		claims: parts.flatMap((p) => p.claims),
		experience: parts.flatMap((p) => p.experience ?? [])
	};
}

const inference = (result: EvidenceResult, skill: string) => result.inferences.find((i) => i.skillKey === skill);
const LANGUAGES = () => new Set(rules.skills.filter((s) => s.kind === 'language').map((s) => s.key));
const compute = (snapshot: EvidenceSnapshot) => computeEvidence(snapshot, rules, AS_OF);

// --- Scenarios ----------------------------------------------------------------------------------------------------------

describe('olympiad participant without commercial experience', () => {
	it('gets the FSP level and confirmed algorithms, and no programming language', () => {
		const final = competition({ id: 'rc-2026' });
		const input = fsp({
			competitions: [final],
			results: [result({ id: 'r1', competitionId: final.id, place: 2 })],
			qualifications: [
				{ id: 'q1', rank: 'KMS', discipline: 'algorithmic', assignedAt: '2026-05-01', basisCompetitionId: final.id }
			]
		});
		const result_ = compute(snapshotOf(input));

		expect(result_.fspLevels).toEqual([
			expect.objectContaining({ discipline: 'algorithmic', level: 'L4', lastResultOn: '2026-03-10' })
		]);
		expect(inference(result_, 'algorithms')).toMatchObject({
			band: 'strong',
			attestation: 'direct',
			badgeTrust: 'fsp_verified'
		});
		// A result proves no programming language.
		expect(result_.inferences.filter((i) => LANGUAGES().has(i.skillKey))).toEqual([]);
		expect(result_.experienceSummary.total).toEqual({ min_months: 0, max_months: 0 });
	});
});

describe('a resume beside FSP achievements', () => {
	it('keeps the skills of the resume and adds the FSP level, the experience unchanged', () => {
		const analyst = () =>
			resume({
				entries: [{ roleKey: 'data_analyst', periodFrom: '2019-01-01', appliedSkillKeys: ['sql', 'python', 'pandas'] }]
			});
		const achievements = fsp({
			qualifications: [{ id: 'q-ii', rank: 'II', discipline: 'algorithmic', assignedAt: '2025-04-01' }]
		});
		const without = compute(snapshotOf(analyst()));
		const withFsp = compute(snapshotOf(analyst(), achievements));

		expect(withFsp.experienceSummary.total).toEqual(without.experienceSummary.total);
		expect(inference(withFsp, 'sql')).toMatchObject({ attestation: inference(without, 'sql')?.attestation });
		expect(without.fspLevels).toEqual([]);
		expect(withFsp.fspLevels).toEqual([expect.objectContaining({ discipline: 'algorithmic', level: 'L2' })]);
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
		const result_ = compute(snapshotOf(input));

		expect(result_.inferences.filter((i) => LANGUAGES().has(i.skillKey))).toEqual([]);
		expect(inference(result_, 'teamwork')).toMatchObject({ attestation: 'derived', badgeTrust: null });
		expect(inference(result_, 'teamwork')?.contributions[0]).toMatchObject({ team_factor: 0.7 });
		expect(result_.inferences.every((i) => i.badgeTrust === null)).toBe(true);
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
		const result_ = compute(snapshotOf(input));
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
		const result_ = compute(snapshotOf(achievements, line));
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
		const algorithms = inference(compute(snapshotOf(input)), 'algorithms');
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
			const own = inference(compute(snapshotOf(input)), 'algorithms')?.contributions[0];
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

describe('resume evidence', () => {
	it('gives no inference from a negated mention', () => {
		const input = resume({
			mentions: [
				{ skill: 'go', polarity: 'negated' },
				{ skill: 'rust', polarity: 'uncertain' }
			]
		});
		const result_ = compute(snapshotOf(input));
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
		const go = inference(compute(snapshotOf(input)), 'go');
		expect(go?.contributions).toHaveLength(4);
		expect(go?.strength).toBe(rules.params.evidence.claimWeights.resumeAppliedSkill);
	});

	it('passes a partial derived contribution from a framework to its language', () => {
		const result_ = compute(snapshotOf(resume({ mentions: [{ skill: 'spring_boot' }] })));
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
		const result_ = compute(snapshotOf(codeforces({ rating: 1700, maxRating: 1950, solvedCount: 300 })));
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
		const stronger = compute(snapshotOf(codeforces({ rating: 2500, maxRating: 2500, solvedCount: 900 })));
		expect(inference(stronger, 'algorithms')?.strength ?? 0).toBeGreaterThan(
			inference(result_, 'algorithms')?.strength ?? 1
		);
		const idle = compute(snapshotOf(codeforces({ rating: 1900, maxRating: 1900, solvedCount: 3 })));
		expect(inference(idle, 'algorithms')).toBeUndefined();
		expect(idle.unused.map((u) => u.code)).toContain('too_few_solved');
	});

	it('confirms a GitHub language above its share, weaker than a platform test of it', () => {
		const result_ = compute(
			snapshotOf(
				github(
					[
						{ name: 'C++', share: 0.6 },
						{ name: 'Python', share: 0.35 },
						{ name: 'Shell', share: 0.05 }
					],
					'public_verifiable'
				)
			)
		);
		const cpp = inference(result_, 'cpp');
		expect(cpp).toMatchObject({ attestation: 'direct', badgeTrust: 'public_verifiable' });
		expect(cpp?.strength ?? 1).toBeLessThan(rules.params.evidence.claimWeights.platformTest);
		expect(inference(result_, 'python')?.strength ?? 1).toBeLessThan(cpp?.strength ?? 0);
		// Below the minimum share a language confirms nothing.
		expect(inference(result_, 'bash')).toBeUndefined();
	});

	it('gives no badge from a profile whose ownership is not verified', () => {
		const result_ = compute(snapshotOf(github([{ name: 'Go', share: 0.9 }], 'claimed')));
		expect(inference(result_, 'go')).toMatchObject({ attestation: 'claimed', badgeTrust: null });
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

describe('rule set versions and determinism', () => {
	it('gives the same result for the same snapshot, rules and as_of', () => {
		const final = competition({ id: 'rc-det' });
		const input = snapshotOf(
			fsp({ competitions: [final], results: [result({ id: 'r-det', competitionId: final.id })] }),
			resume({ mentions: [{ skill: 'cpp' }], entries: [{ periodFrom: '2024-01-01', appliedSkillKeys: ['cpp'] }] })
		);
		expect(compute(input)).toEqual(compute(structuredClone(input)));
	});

	it('computes another result under another rule set version', () => {
		const input = snapshotOf(resume({ entries: [{ periodFrom: '2023-01-01', appliedSkillKeys: ['go', 'sql'] }] }));
		const weaker: RulesContext = {
			...rules,
			rulesetId: '00000000-0000-7000-8000-00000000cccc',
			rulesetVersion: rules.rulesetVersion + 1,
			params: {
				...rules.params,
				evidence: {
					...rules.params.evidence,
					claimWeights: { ...rules.params.evidence.claimWeights, resumeAppliedSkill: 0.05 }
				}
			}
		};
		const before = inference(compute(input), 'go');
		const after = inference(computeEvidence(input, weaker, AS_OF), 'go');
		expect(after?.strength ?? 1).toBeLessThan(before?.strength ?? 0);
	});
});

describe('a platform test fact', () => {
	it('confirms the skills it checks directly, with the platform badge', () => {
		const work = resume({ entries: [{ periodFrom: '2021-01-01', appliedSkillKeys: ['go', 'sql'] }] });
		const test = {
			facts: [
				{
					id: nextId(),
					source: 'platform_test' as const,
					factType: 'test_score',
					sourceRecordRef: `test:score:${nextId()}`,
					eventKey: 'test:assessment:go-level',
					trustLevel: 'platform_verified' as const,
					occurredOn: '2026-09-01',
					payload: { assessmentId: 'go-level', skillKeys: ['go'], levelStrength: 0.8, gradeKey: 'middle' }
				}
			],
			claims: []
		};
		expect(inference(compute(snapshotOf(work, test)), 'go')).toMatchObject({
			attestation: 'direct',
			badgeTrust: 'platform_verified'
		});
	});
});
