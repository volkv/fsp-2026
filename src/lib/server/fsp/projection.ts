// Snapshot → source facts (layer 1) → claims by the projection rules (layer 2): docs/contracts.md 1.4,
// docs/domain.md 9.1–9.3. Pure functions over a snapshot and one published taxonomy version; the adapter does not
// infer skills, the rules of the taxonomy do. Recency is applied by the categorization at its `as_of`, not here.
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '$lib/server/db';
import { fspProjectionRules, fspStrengthParams, receiptTemplates } from '$lib/server/db/schema';
import { canonicalJson } from '$lib/server/json/canonical';
import { receiptLimitsSchema, type ReceiptLimits } from '$lib/server/taxonomy/datasets';
import { latestPublishedVersion } from '$lib/server/taxonomy/vocabulary';
import {
	AGE_GROUPS,
	COMPETITION_LEVELS,
	DISCIPLINE_CODES,
	EVSK_RANKS,
	QUALIFICATION_RANKS,
	STAGES,
	type AchievementsSnapshot,
	type Competition,
	type DisciplineCode,
	type EvskRank,
	type NationalTeam,
	type PlatformAccount,
	type Qualification,
	type Result
} from './types';

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export type FactPayload =
	| { factType: 'competition_result'; payload: { result: Result; competition: Competition } }
	| { factType: 'qualification'; payload: { qualification: Qualification } }
	| { factType: 'national_team'; payload: { nationalTeam: NationalTeam } }
	| { factType: 'platform_rating'; payload: { account: PlatformAccount } };

export type FactDraft = FactPayload & {
	sourceRecordRef: string;
	eventKey: string;
	payloadSha256: string;
	occurredOn: string | null;
	/** What the source says about the record: an annulled result is kept as `annulled`. */
	status: 'active' | 'annulled';
};

/** SHA-256 of the canonical snapshot without `generatedAt` (contracts 1.4). */
export function snapshotSha256(snapshot: AchievementsSnapshot): string {
	return sha256Hex(canonicalJson({ ...snapshot, generatedAt: undefined }));
}

function draft(
	value: FactPayload,
	ref: string,
	eventKey: string,
	occurredOn: string | null,
	status: FactDraft['status']
): FactDraft {
	return {
		...value,
		sourceRecordRef: ref,
		eventKey,
		payloadSha256: sha256Hex(canonicalJson(value.payload)),
		occurredOn,
		status
	};
}

export class SnapshotInconsistency extends Error {
	override name = 'SnapshotInconsistency';
}

/**
 * The fact of one competition result, whichever variant of the source stated it (contracts 1.4, 1.7): keyed by the
 * source's record id and grouped by the competition, which carries no personal data.
 */
export function resultFact(result: Result, competition: Competition): FactDraft {
	if (result.competitionId !== competition.id) {
		throw new SnapshotInconsistency('a result is paired with another competition');
	}
	return draft(
		{ factType: 'competition_result', payload: { result, competition } },
		`fsp:result:${result.id}`,
		`fsp:competition:${result.competitionId}`,
		competition.startDate,
		result.status === 'annulled' ? 'annulled' : 'active'
	);
}

/**
 * The facts a snapshot states. Every record is keyed by the source's own id (`source_record_ref`); a result
 * embeds its competition, which carries no personal data, so the fact is self-contained for cards and receipts.
 */
export function snapshotFacts(snapshot: AchievementsSnapshot): FactDraft[] {
	const competitions = new Map(snapshot.competitions.map((c) => [c.id, c]));
	const facts: FactDraft[] = [];
	for (const result of snapshot.results) {
		const competition = competitions.get(result.competitionId);
		if (!competition) throw new SnapshotInconsistency('a result references a competition absent from the snapshot');
		facts.push(resultFact(result, competition));
	}
	for (const qualification of snapshot.qualifications) {
		const discipline = qualification.discipline ?? 'unknown';
		const ref =
			qualification.id === undefined
				? `fsp:qualification:${discipline}:${qualification.rank}:${qualification.assignedAt}`
				: `fsp:qualification:${qualification.id}`;
		const eventKey =
			qualification.basisCompetitionId == null
				? `fsp:qualification:${discipline}:${qualification.rank}`
				: `fsp:competition:${qualification.basisCompetitionId}`;
		facts.push(
			draft(
				{ factType: 'qualification', payload: { qualification } },
				ref,
				eventKey,
				qualification.assignedAt,
				'active'
			)
		);
	}
	const team = snapshot.athlete.nationalTeam;
	if (team) {
		const key = `fsp:national_team:${team.discipline}:${team.season}`;
		facts.push(draft({ factType: 'national_team', payload: { nationalTeam: team } }, key, key, null, 'active'));
	}
	for (const account of snapshot.athlete.platformAccounts ?? []) {
		facts.push(
			draft(
				{ factType: 'platform_rating', payload: { account } },
				`fsp:platform:${account.platform}:${account.login}`,
				`profile:${account.platform}:${account.login}`,
				null,
				'active'
			)
		);
	}
	const refs = new Set<string>();
	for (const fact of facts) {
		if (refs.has(fact.sourceRecordRef)) throw new SnapshotInconsistency(`record ${fact.sourceRecordRef} appears twice`);
		refs.add(fact.sourceRecordRef);
	}
	return facts;
}

// --- Taxonomy version the projection runs on -------------------------------------------------------------------

const rank = z.enum(EVSK_RANKS);
const strengthParamsSchema = z.object({
	evskNorm: z.object({
		minAge: z.partialRecord(rank, z.int().min(0)),
		eligibleStages: z.array(z.enum(STAGES)),
		u15Disciplines: z.array(z.enum(DISCIPLINE_CODES)),
		placeOverlap: z.literal('first_listed_rank'),
		rows: z.array(
			z.object({
				level: z.enum(COMPETITION_LEVELS),
				ageGroup: z.enum(AGE_GROUPS),
				ranges: z.array(z.object({ rank, fromPlace: z.int().min(1), toPlace: z.int().min(1) }))
			})
		)
	}),
	rankStrength: z.partialRecord(z.enum([...QUALIFICATION_RANKS, 'participation']), z.number().min(0).max(1)),
	formatFactors: z.object({
		rows: z.array(z.object({ stage: z.enum(STAGES), online: z.boolean(), factor: z.number().min(0).max(1) })),
		unknown: z.number().min(0).max(1)
	}),
	unknownRoleFactor: z.number().min(0).max(1)
});
type StrengthParams = z.output<typeof strengthParamsSchema>;

interface ProjectionRule {
	id: string;
	discipline: string;
	targetKind: 'skill' | 'role' | 'marker';
	targetKey: string;
	weight: number;
	attestation: 'direct' | 'derived';
	requiresSpecialization: string | null;
	appliesTo: 'individual' | 'team' | 'any';
}

export interface ReceiptTemplate {
	generalized: readonly string[];
	doesNotAssert: ReceiptLimits;
}

export interface ProjectionTaxonomy {
	versionId: string;
	label: string;
	rules: readonly ProjectionRule[];
	strength: StrengthParams;
	/** Receipt templates of the source `fsp` by fact type. */
	receiptTemplates: ReadonlyMap<string, ReceiptTemplate>;
}

const templateAssertsSchema = z.object({ generalized: z.array(z.string()), exact: z.array(z.string()) });

/** The latest published taxonomy version with its FSP rules, or `null` when none is published yet. */
export async function loadProjectionTaxonomy(executor: Executor): Promise<ProjectionTaxonomy | null> {
	const version = await latestPublishedVersion(executor);
	if (!version) return null;
	const [params] = await executor
		.select()
		.from(fspStrengthParams)
		.where(eq(fspStrengthParams.taxonomyVersionId, version.id));
	if (!params) throw new Error(`taxonomy version ${version.label} has no FSP strength parameters`);
	const rules = await executor
		.select()
		.from(fspProjectionRules)
		.where(eq(fspProjectionRules.taxonomyVersionId, version.id));
	const templates = await executor
		.select()
		.from(receiptTemplates)
		.where(and(eq(receiptTemplates.taxonomyVersionId, version.id), eq(receiptTemplates.source, 'fsp')));
	return {
		versionId: version.id,
		label: version.label,
		rules: rules.map((r) => ({
			id: r.id,
			discipline: r.discipline,
			targetKind: r.targetKind,
			targetKey: r.targetKey,
			weight: Number(r.weight),
			attestation: r.attestation,
			requiresSpecialization: r.requiresSpecialization,
			appliesTo: r.appliesTo
		})),
		strength: strengthParamsSchema.parse({
			evskNorm: params.evskNorm,
			rankStrength: params.rankStrength,
			formatFactors: params.formatFactors,
			unknownRoleFactor: Number(params.unknownRoleFactor)
		}),
		receiptTemplates: new Map(
			templates.map((t) => [
				t.factType,
				{
					generalized: templateAssertsSchema.parse(t.asserts).generalized,
					doesNotAssert: receiptLimitsSchema.parse(t.doesNotAssert)
				}
			])
		)
	};
}

// --- Claims -----------------------------------------------------------------------------------------------------

interface ClaimDraft {
	claimType: 'skill_mention' | 'role_title' | 'responsibility_marker' | 'team_role';
	skillKey: string | null;
	rawText: string;
	value: Record<string, unknown>;
}

const CLAIM_TYPE = { skill: 'skill_mention', role: 'role_title', marker: 'responsibility_marker' } as const;

function isDiscipline(value: string | undefined): value is DisciplineCode {
	return (DISCIPLINE_CODES as readonly string[]).includes(value ?? '');
}

/** `format_factor` by stage and on-site/online; an unknown format counts as an online qualifier (domain 9.3). */
function formatFactor(competition: Competition, params: StrengthParams): number {
	const { stage, online } = competition;
	if (stage === undefined || stage === 'unknown' || online === undefined) return params.formatFactors.unknown;
	const row = params.formatFactors.rows.find((r) => r.stage === stage && r.online === online);
	return row?.factor ?? params.formatFactors.unknown;
}

/**
 * EVSK equivalent of a result: the norm the source recorded, or the norm table of the taxonomy (level × age group
 * × place) when every input is known. A contribution indicator, never an assigned rank (domain 9.1).
 */
function computedIndicator(
	result: Result,
	competition: Competition,
	birthYear: number | null | undefined,
	params: StrengthParams
): { rank: EvskRank; basis: 'source' | 'evsk_table' } | null {
	if (result.evskFulfilled) return { rank: result.evskFulfilled, basis: 'source' };
	const { level, ageGroup, stage, discipline } = competition;
	const norm = params.evskNorm;
	if (result.place === null || birthYear == null) return null;
	if (level === 'unknown' || ageGroup === undefined || ageGroup === 'unknown') return null;
	if (stage === undefined || stage === 'unknown' || !norm.eligibleStages.includes(stage)) return null;
	if (ageGroup === 'boys_girls_u15' && !(isDiscipline(discipline) && norm.u15Disciplines.includes(discipline)))
		return null;
	const row = norm.rows.find((r) => r.level === level && r.ageGroup === ageGroup);
	const place = result.place;
	const range = row?.ranges.find((r) => r.fromPlace <= place && place <= r.toPlace);
	if (!range) return null;
	// Without the birth date the oldest possible age at the competition is the year difference.
	const oldest = Number(competition.startDate.slice(0, 4)) - birthYear;
	const minAge = norm.minAge[range.rank];
	if (minAge !== undefined && oldest < minAge) return null;
	return { rank: range.rank, basis: 'evsk_table' };
}

function ruleClaims(
	rules: readonly ProjectionRule[],
	taxonomy: ProjectionTaxonomy,
	common: Record<string, unknown>,
	factor: (rule: ProjectionRule) => Record<string, unknown>
): ClaimDraft[] {
	return rules.map((rule) => ({
		claimType: CLAIM_TYPE[rule.targetKind],
		skillKey: rule.targetKind === 'skill' ? rule.targetKey : null,
		rawText: `fsp_projection ${rule.discipline}/${rule.appliesTo}/${rule.requiresSpecialization ?? '*'} -> ${rule.targetKind}:${rule.targetKey}`,
		value: {
			target_kind: rule.targetKind,
			target_key: rule.targetKey,
			rule_id: rule.id,
			rule_version: taxonomy.label,
			taxonomy_version_id: taxonomy.versionId,
			weight: rule.weight,
			attestation: rule.attestation,
			trust_level: 'fsp_verified',
			...common,
			...factor(rule)
		}
	}));
}

/**
 * Claims of one active fact. Only official placed results and known ranks count; a team result is matched only by
 * team and «any» rules, so it never confirms a skill directly, and a skill of a specialization only follows when
 * the source passed that very specialization (domain 9.3).
 */
export function factClaims(
	fact: FactDraft,
	birthYear: number | null | undefined,
	taxonomy: ProjectionTaxonomy
): ClaimDraft[] {
	const { strength } = taxonomy;
	if (fact.status !== 'active') return [];
	if (fact.factType === 'competition_result') {
		const { result, competition } = fact.payload;
		if (result.status !== 'official' || result.place === null || !isDiscipline(competition.discipline)) return [];
		const discipline = competition.discipline;
		const team = result.team ?? null;
		const isTeam = team !== null || competition.format === 'team';
		const specialization = team?.specialization ?? null;
		const applicable = taxonomy.rules.filter(
			(rule) =>
				rule.discipline === discipline &&
				(rule.appliesTo === 'any' || rule.appliesTo === (isTeam ? 'team' : 'individual')) &&
				(rule.requiresSpecialization === null || (isTeam && rule.requiresSpecialization === specialization))
		);
		const indicator = computedIndicator(result, competition, birthYear, strength);
		const strengthOfResult = strength.rankStrength[indicator?.rank ?? 'participation'];
		if (strengthOfResult === undefined) throw new Error('rank strength table misses a rank');
		const common = {
			group_key: fact.eventKey,
			strength_of_result: strengthOfResult,
			computed_indicator: indicator?.rank ?? null,
			indicator_basis: indicator?.basis ?? null,
			format_factor: formatFactor(competition, strength)
		};
		const claims = ruleClaims(applicable, taxonomy, common, (rule) =>
			isTeam ? { team_factor: rule.requiresSpecialization === null ? strength.unknownRoleFactor : 1 } : {}
		);
		if (team?.role !== undefined && team.role !== 'unknown') {
			claims.push({
				claimType: 'team_role',
				skillKey: null,
				rawText: `team.role=${team.role}`,
				value: { role: team.role, group_key: fact.eventKey, trust_level: 'fsp_verified' }
			});
		}
		return claims;
	}
	if (fact.factType === 'qualification') {
		const { qualification } = fact.payload;
		if (qualification.rank === 'unknown' || !isDiscipline(qualification.discipline)) return [];
		const discipline = qualification.discipline;
		const strengthOfRank = strength.rankStrength[qualification.rank];
		if (strengthOfRank === undefined) throw new Error('rank strength table misses a rank');
		// An assigned rank is a personal status: individual and «any» rules without a specialization.
		const applicable = taxonomy.rules.filter(
			(rule) => rule.discipline === discipline && rule.appliesTo !== 'team' && rule.requiresSpecialization === null
		);
		return ruleClaims(
			applicable,
			taxonomy,
			{ group_key: fact.eventKey, strength_of_result: strengthOfRank, qualification_rank: qualification.rank },
			() => ({})
		);
	}
	// A national team membership feeds the FSP level facet, a platform account the external profile group: the
	// projection rules have no skill targets for them.
	return [];
}

// --- Receipts ---------------------------------------------------------------------------------------------------

/** Values a generalized receipt may assert about a fact (receipt templates, domain 9.6). */
export function generalizedAssertions(fact: FactPayload): Record<string, string | number> {
	switch (fact.factType) {
		case 'competition_result': {
			const { result, competition } = fact.payload;
			const format = competition.online === undefined ? 'unknown' : competition.online ? 'online' : 'onsite';
			return {
				discipline: competition.discipline,
				competitionLevel: competition.level,
				season: Number(competition.startDate.slice(0, 4)),
				resultGroup: result.award ?? 'unknown',
				format
			};
		}
		case 'qualification': {
			const { qualification } = fact.payload;
			return {
				discipline: qualification.discipline ?? 'unknown',
				rank: qualification.rank,
				assignedYear: Number(qualification.assignedAt.slice(0, 4))
			};
		}
		case 'national_team': {
			const { nationalTeam } = fact.payload;
			return { discipline: nationalTeam.discipline, season: nationalTeam.season, squad: nationalTeam.squad };
		}
		case 'platform_rating':
			return { platform: fact.payload.account.platform };
	}
}

/** Whether a fact is confirmed enough for a receipt: annulled, preliminary and unplaced results are not. */
export function receiptEligible(fact: FactDraft): boolean {
	if (fact.status !== 'active') return false;
	if (fact.factType === 'competition_result') return fact.payload.result.status === 'official';
	return true;
}
