// Input and output of the evidence calculation (docs/domain.md 9.3, 9.5, 12.6). The input is a snapshot of one profile
// revision plus fixed taxonomy and rule set versions; the output is what a run stores. Parts stored as jsonb
// (contributions, experience summary) use the snake_case names of the model.
import type { CategorizationParams, SkillKind, StrengthBand } from './params';

export type FactSource = 'fsp' | 'platform_test' | 'codeforces' | 'github' | 'resume';
export type TrustLevel = 'fsp_verified' | 'platform_verified' | 'public_verifiable' | 'claimed';
export type Attestation = 'direct' | 'derived' | 'claimed';
export type FspLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

/** An active source fact (layer 1). */
export interface FactInput {
	id: string;
	source: FactSource;
	factType: string;
	sourceRecordRef: string;
	eventKey: string | null;
	trustLevel: TrustLevel;
	occurredOn: string | null;
	payload: unknown;
}

/** An active claim (layer 2) the candidate did not reject. */
export interface ClaimInput {
	id: string;
	factId: string;
	claimType: string;
	extractor: 'rules' | 'model' | 'source_mapping';
	skillKey: string | null;
	eventKey: string | null;
	polarity: 'asserted' | 'negated' | 'uncertain';
	candidateReview: 'pending' | 'confirmed';
	experienceEntryId: string | null;
	value: unknown;
}

/** An active experience entry the candidate did not reject (domain 9.5). */
export interface ExperienceInput {
	id: string;
	factId: string;
	roleKey: string | null;
	periodFrom: string | null;
	periodTo: string | null;
	periodFromPrecision: 'month' | 'year' | null;
	periodToPrecision: 'month' | 'year' | null;
	isCurrent: boolean;
	appliedSkillKeys: string[];
	periodStatus: 'valid' | 'missing' | 'invalid';
	candidateReview: 'pending' | 'confirmed' | 'edited';
}

/** Everything the calculation reads about the candidate at one profile revision. */
export interface EvidenceSnapshot {
	candidateId: string;
	revision: number;
	facts: FactInput[];
	claims: ClaimInput[];
	experience: ExperienceInput[];
}

export type LevelCriterion =
	| { kind: 'rank'; minRank: string; basis: ('qualification' | 'evsk_indicator')[] }
	| { kind: 'national_team'; squads: ('main' | 'reserve')[] }
	| { kind: 'participation'; resultStatuses: 'official'[] };

export interface RoleRule {
	key: string;
	family: string;
	coreSkillGroups: string[][];
	typicalSkills: string[];
}

/** Taxonomy version and rule set a run is computed with. */
export interface RulesContext {
	taxonomyVersionId: string;
	taxonomyLabel: string;
	rulesetId: string;
	rulesetVersion: number;
	params: CategorizationParams;
	roles: RoleRule[];
	skills: { key: string; kind: SkillKind; parentKey: string | null }[];
	grades: { key: string; ordinal: number }[];
	fspLevelRules: { level: FspLevel; criteria: { anyOf: LevelCriterion[] } }[];
}

/** One weighted piece of evidence for a skill or a role (`skill_inferences.contributions`, domain 9.3). */
export interface Contribution {
	basis: 'fsp_projection' | 'resume_mention' | 'resume_experience' | 'platform_test' | 'public_profile' | 'child_skill';
	source: FactSource;
	fact_id: string;
	claim_id: string | null;
	experience_entry_id: string | null;
	group_key: string;
	/** Rule of the projection (`fsp_projection_rules.id`) or the weight of the rule set that produced the weight. */
	rule_id: string;
	rule_version: string;
	weight: number;
	strength_of_result: number | null;
	format_factor: number | null;
	team_factor: number | null;
	recency_factor: number;
	computed_indicator: string | null;
	/** Child skill the contribution passed up from. */
	via_skill: string | null;
	contribution: number;
	trust_level: TrustLevel;
	attestation: Attestation;
}

export interface SkillInference {
	skillKey: string;
	/** Weight of the grounds, 0…1; not a probability. */
	strength: number;
	band: StrengthBand;
	attestation: Attestation;
	badgeTrust: TrustLevel | null;
	contributions: Contribution[];
}

/** Months as a range: a year-precision period gives a lower and an upper bound (domain 9.5). */
export interface MonthsRange {
	min_months: number;
	max_months: number;
}

export interface ExperienceSummary {
	total: MonthsRange;
	by_role: Record<string, MonthsRange>;
	by_skill: Record<string, MonthsRange>;
	counted_entry_ids: string[];
	excluded: { experience_entry_id: string; code: 'period_missing' | 'period_invalid' }[];
}

export interface FspLevelResult {
	discipline: string;
	level: FspLevel;
	basisFactIds: string[];
	lastResultOn: string | null;
}

export interface EvidenceResult {
	experienceSummary: ExperienceSummary;
	inferences: SkillInference[];
	fspLevels: FspLevelResult[];
	/** Facts and claims in the snapshot the rules gave no weight, with the reason. */
	unused: { fact_id: string; claim_id: string | null; code: string }[];
}
