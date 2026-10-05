import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SpecializationKey } from '$lib/server/assessments/contract/catalog';
import type {
	EvidenceSnapshot,
	ClaimInput,
	ExperienceInput,
	FactInput,
	RulesContext
} from '$lib/server/evidence/types';
import { factClaims, snapshotFacts, type ProjectionTaxonomy } from '$lib/server/fsp/projection';
import type { AchievementsSnapshot, Qualification } from '$lib/server/fsp/types';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { gradeHint, gradeHintSchema, monthsText } from './hint';

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

let sequence = 0;
const nextId = () => `00000000-0000-7000-8000-${(++sequence).toString(16).padStart(12, '0')}`;

interface Part {
	facts: FactInput[];
	claims: ClaimInput[];
	experience?: ExperienceInput[];
}

/** FSP facts and claims as the synchronization writes them. */
function fsp(input: { place?: number; participation?: boolean; qualifications?: Omit<Qualification, 'id'>[] }): Part {
	const competition = {
		id: 'rc-2026',
		ekpNumber: null,
		title: 'Чемпионат России по спортивному программированию',
		discipline: 'algorithmic',
		level: 'russian_championship',
		stage: 'final',
		ageGroup: 'adults',
		format: 'individual',
		startDate: '2026-03-10',
		online: false
	} as const;
	const snapshot: AchievementsSnapshot = {
		athlete: { fspId: 'athlete-1', lastName: 'Иванов', firstName: 'Иван', birthYear: 2003, nationalTeam: null },
		competitions: [competition],
		results: [
			{
				id: 'r1',
				competitionId: competition.id,
				place: input.place ?? 40,
				status: 'official',
				award: input.participation ? 'participant' : 'prize'
			}
		],
		qualifications: (input.qualifications ?? []).map((q, index) => ({ id: `q${index}`, ...q })),
		generatedAt: '2026-09-20T00:00:00Z',
		completeness: { complete: true, sourceVersion: 'v1', pages: { fetched: 1, total: 1 } }
	};
	const part: Part = { facts: [], claims: [] };
	for (const draft of snapshotFacts(snapshot)) {
		const factId = nextId();
		part.facts.push({
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
			part.claims.push({
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
	return part;
}

function resume(input: { markers?: string[]; entries?: Partial<ExperienceInput>[] }): Part {
	const factId = nextId();
	return {
		facts: [
			{
				id: factId,
				source: 'resume',
				factType: 'resume_document',
				sourceRecordRef: `resume:${nextId()}`,
				eventKey: null,
				trustLevel: 'claimed',
				occurredOn: null,
				payload: {}
			}
		],
		claims: (input.markers ?? []).map((marker) => ({
			id: nextId(),
			factId,
			claimType: 'responsibility_marker',
			extractor: 'model',
			skillKey: null,
			eventKey: null,
			polarity: 'asserted',
			candidateReview: 'confirmed',
			experienceEntryId: null,
			value: { marker }
		})),
		experience: (input.entries ?? []).map((e) => ({
			id: nextId(),
			factId,
			roleKey: 'backend',
			periodFrom: '2022-01-01',
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

function codeforces(maxRating: number): Part {
	return {
		facts: [
			{
				id: nextId(),
				source: 'codeforces',
				factType: 'platform_rating',
				sourceRecordRef: 'codeforces:user:solver',
				eventKey: 'profile:codeforces:solver',
				trustLevel: 'public_verifiable',
				occurredOn: '2026-09-12',
				payload: {
					account: { platform: 'codeforces', login: 'Solver', rating: maxRating },
					maxRating,
					rank: null,
					maxRank: null,
					solvedCount: 400,
					ratedContests: 30,
					lastRatedOn: '2026-09-12',
					registeredOn: '2020-01-01'
				}
			}
		],
		claims: []
	};
}

function hint(specialization: SpecializationKey, ...parts: Part[]) {
	const snapshot: EvidenceSnapshot = {
		candidateId: '00000000-0000-7000-8000-0000000000c1',
		revision: 1,
		facts: parts.flatMap((p) => p.facts),
		claims: parts.flatMap((p) => p.claims),
		experience: parts.flatMap((p) => p.experience ?? [])
	};
	const result = gradeHint({
		snapshot,
		rules,
		specialization,
		skillNames: { algorithms: 'Алгоритмы' },
		asOf: AS_OF
	});
	// What a declaration stores reads back as the same hint.
	expect(gradeHintSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
	return result;
}

describe('the grade hint', () => {
	it('suggests nothing without grounds and says so', () => {
		const result = hint('backend');
		expect(result.suggested).toBeNull();
		expect(result.bases).toEqual([]);
		expect(result.caveats).toContain('Оснований для подсказки нет: выберите грейд сами');
	});

	it('takes the grade from the experience in the specialization, by the bands of the rule set', () => {
		// Since January 2022: more than three years — the band of Middle.
		const long = hint('backend', resume({ entries: [{}] }));
		expect(long.suggested).toBe('middle');
		expect(long.bases).toEqual([
			expect.objectContaining({ source: 'resume', text: expect.stringContaining('Опыт по специализации') as unknown })
		]);
		const short = hint('backend', resume({ entries: [{ periodFrom: '2025-12-01' }] }));
		expect(short.suggested).toBe('junior');
	});

	it('raises the grade by a responsibility marker of the resume within the band', () => {
		const result = hint('backend', resume({ markers: ['mentoring'], entries: [{}] }));
		expect(result.suggested).toBe('senior');
		expect(result.bases).toContainEqual(
			expect.objectContaining({ source: 'resume', text: 'В резюме: наставничество' })
		);
	});

	it('counts only the experience of the roles of the specialization', () => {
		expect(hint('frontend', resume({ entries: [{}] })).suggested).toBeNull();
		expect(hint('frontend', resume({ entries: [{ roleKey: 'fullstack' }] })).suggested).toBe('middle');
	});

	it('names the undated experience it left out', () => {
		const result = hint(
			'backend',
			resume({ entries: [{ periodFrom: null, periodStatus: 'missing', isCurrent: false }] })
		);
		expect(result.suggested).toBeNull();
		expect(result.caveats[0]).toContain('без дат не учтено');
	});

	it('lets FSP suggest a grade, never above Junior by itself', () => {
		const strong = hint(
			'backend',
			fsp({
				place: 2,
				qualifications: [
					{ rank: 'KMS', discipline: 'algorithmic', assignedAt: '2026-05-01', basisCompetitionId: 'rc-2026' }
				]
			})
		);
		expect(strong.suggested).toBe('junior');
		expect(strong.bases).toEqual([expect.objectContaining({ source: 'fsp', fact_id: expect.any(String) as unknown })]);
		expect(strong.caveats.some((c) => c.includes('не производственный опыт'))).toBe(true);
		const participant = hint('backend', fsp({ participation: true }));
		expect(participant.suggested).toBe('intern');
	});

	it('does not let FSP lower or replace production experience', () => {
		const result = hint(
			'backend',
			resume({ entries: [{}] }),
			fsp({
				place: 2,
				qualifications: [
					{ rank: 'MS', discipline: 'algorithmic', assignedAt: '2026-05-01', basisCompetitionId: 'rc-2026' }
				]
			})
		);
		expect(result.suggested).toBe('middle');
		expect(result.bases.map((b) => b.source)).toEqual(['resume', 'fsp']);
	});

	it('reads a verified public profile as a ground of skills of the specialization', () => {
		const result = hint('backend', codeforces(2100));
		expect(result.suggested).toBe('junior');
		expect(result.bases).toEqual([
			expect.objectContaining({ source: 'public_profile', text: 'Codeforces подтверждает навыки: Алгоритмы' })
		]);
		// Frontend tests no algorithms block: Codeforces is no ground there.
		expect(hint('frontend', codeforces(2100)).bases).toEqual([]);
	});

	it('writes months in words', () => {
		expect(monthsText(0)).toBe('меньше месяца');
		expect(monthsText(7)).toBe('7 месяцев');
		expect(monthsText(26)).toBe('2 года 2 месяца');
	});
});
