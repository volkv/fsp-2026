// Facet «FSP level» by discipline (docs/domain.md 12.2, taxonomy `fsp_level_rules`): the highest level whose criterion
// at least one `fsp_verified` fact meets. A separate facet of the catalog, never a grade.
import { z } from 'zod';
import type { FactInput, ClaimInput, FspLevel, FspLevelResult, LevelCriterion, RulesContext } from './types';

/** Ranks and titles from the highest. */
const RANK_ORDER = ['ZMS', 'MSMK', 'MS', 'KMS', 'I', 'II', 'III', 'Y1', 'Y2', 'Y3'] as const;
const rankIndex = (rank: string) => (RANK_ORDER as readonly string[]).indexOf(rank);
const LEVEL_ORDER: readonly FspLevel[] = ['L5', 'L4', 'L3', 'L2', 'L1'];

const resultPayload = z.looseObject({
	result: z.looseObject({
		status: z.string(),
		evskFulfilled: z.string().nullable().optional(),
		team: z.looseObject({ role: z.string().optional() }).nullable().optional()
	}),
	competition: z.looseObject({ discipline: z.string() })
});
const qualificationPayload = z.looseObject({
	qualification: z.looseObject({ rank: z.string(), discipline: z.string().optional() })
});
const nationalTeamPayload = z.looseObject({
	nationalTeam: z.looseObject({ discipline: z.string(), squad: z.enum(['main', 'reserve']) })
});
const indicatorValue = z.looseObject({ computed_indicator: z.string().nullable().optional() });

/** Team members who did not compete: their team's result is not their own result. */
export const NOT_COMPETING: ReadonlySet<string> = new Set(['reserve', 'trainer']);

interface Observation {
	factId: string;
	discipline: string;
	qualificationRank: string | null;
	indicatorRank: string | null;
	nationalSquad: 'main' | 'reserve' | null;
	officialResult: boolean;
	resultOn: string | null;
}

function observe(fact: FactInput, claims: readonly ClaimInput[]): Observation | null {
	const base = { factId: fact.id, qualificationRank: null, indicatorRank: null, nationalSquad: null, resultOn: null };
	if (fact.factType === 'competition_result') {
		const { result, competition } = resultPayload.parse(fact.payload);
		if (result.status !== 'official') return null;
		if (result.team?.role !== undefined && NOT_COMPETING.has(result.team.role)) return null;
		const fromClaims = claims
			.map((claim) => indicatorValue.safeParse(claim.value))
			.find((parsed) => parsed.success && parsed.data.computed_indicator != null);
		const indicator = fromClaims?.data?.computed_indicator ?? result.evskFulfilled ?? null;
		return {
			...base,
			discipline: competition.discipline,
			indicatorRank: indicator,
			officialResult: true,
			resultOn: fact.occurredOn
		};
	}
	if (fact.factType === 'qualification') {
		const { qualification } = qualificationPayload.parse(fact.payload);
		if (qualification.discipline === undefined || qualification.discipline === 'unknown') return null;
		return {
			...base,
			discipline: qualification.discipline,
			qualificationRank: qualification.rank,
			officialResult: false
		};
	}
	if (fact.factType === 'national_team') {
		const { nationalTeam } = nationalTeamPayload.parse(fact.payload);
		return { ...base, discipline: nationalTeam.discipline, nationalSquad: nationalTeam.squad, officialResult: false };
	}
	return null;
}

const atLeast = (rank: string | null, minRank: string) =>
	rank !== null && rankIndex(rank) >= 0 && rankIndex(rank) <= rankIndex(minRank);

function meets(observation: Observation, criterion: LevelCriterion): boolean {
	switch (criterion.kind) {
		case 'rank':
			return (
				(criterion.basis.includes('qualification') && atLeast(observation.qualificationRank, criterion.minRank)) ||
				(criterion.basis.includes('evsk_indicator') && atLeast(observation.indicatorRank, criterion.minRank))
			);
		case 'national_team':
			return observation.nationalSquad !== null && criterion.squads.includes(observation.nationalSquad);
		case 'participation':
			return observation.officialResult;
	}
}

/** Levels by discipline from `fsp_verified` facts, ordered by discipline. */
export function fspLevels(
	facts: readonly FactInput[],
	claimsByFact: ReadonlyMap<string, readonly ClaimInput[]>,
	rules: RulesContext
): FspLevelResult[] {
	const byDiscipline = new Map<string, Observation[]>();
	for (const fact of facts) {
		if (fact.source !== 'fsp' || fact.trustLevel !== 'fsp_verified') continue;
		const observation = observe(fact, claimsByFact.get(fact.id) ?? []);
		if (!observation) continue;
		byDiscipline.set(observation.discipline, [...(byDiscipline.get(observation.discipline) ?? []), observation]);
	}
	const levelRules = [...rules.fspLevelRules].sort(
		(a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level)
	);
	const results: FspLevelResult[] = [];
	for (const [discipline, observations] of [...byDiscipline.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
		for (const rule of levelRules) {
			const basis = observations.filter((o) => rule.criteria.anyOf.some((criterion) => meets(o, criterion)));
			if (basis.length === 0) continue;
			const dates = observations.map((o) => o.resultOn).filter((d): d is string => d !== null);
			results.push({
				discipline,
				level: rule.level,
				basisFactIds: basis.map((o) => o.factId).sort(),
				lastResultOn: dates.length === 0 ? null : dates.reduce((a, b) => (a > b ? a : b))
			});
			break;
		}
	}
	return results;
}
