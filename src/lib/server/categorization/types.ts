// Input and output of the categorization calculation (docs/domain.md 9.3, 9.5, 12.1, 12.2). The input is a snapshot of
// one profile revision plus fixed taxonomy and rule set versions; the output is what a run stores. Parts stored as
// jsonb (contributions, explanations, missing grounds, experience summary) use the snake_case names of the model.
import type { CategorizationParams, Marker, SkillKind, StrengthBand } from './params';

export type FactSource = 'fsp' | 'platform_test' | 'codeforces' | 'github' | 'resume' | 'self_declared';
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
export interface CategorizationSnapshot {
	candidateId: string;
	revision: number;
	/** Shown next to the inferred role; never an input of the axes (domain 12.2). */
	desiredRoleKeys: string[];
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

/** A code of a missing ground with its structured parameters; the interface words it, the run stores no prose. */
export interface MissingItem {
	code: string;
	[parameter: string]: unknown;
}

export interface MissingByAxis {
	role: MissingItem[];
	grade: MissingItem[];
	stack: MissingItem[];
}

export type AxisStatus = 'established' | 'insufficient_data';

export interface AssignmentResult {
	rank: 'primary' | 'secondary';
	roleStatus: AxisStatus;
	roleKey: string | null;
	score: number | null;
	gradeStatus: AxisStatus;
	gradeMin: string | null;
	gradeMax: string | null;
	gradeConfidence: number | null;
	stackStatus: AxisStatus;
	stackSkillKeys: string[];
	explanation: AssignmentExplanation;
}

export interface CoreGroupExplanation {
	skills: string[];
	satisfied_by: string | null;
	strength: number;
}

export interface RoleExplanation {
	role_key: string;
	score: number;
	skill_fit: number;
	role_evidence: number;
	/**
	 * The role stands without FSP: resume, experience and platform tests establish it by themselves. A role only FSP
	 * supports is never primary over one that does.
	 */
	established_without_fsp: boolean;
	core_groups: CoreGroupExplanation[];
	/** Skills of core groups nothing confirmed above the threshold: «not confirmed», not «absent». */
	unconfirmed_core_groups: string[][];
	contributions: Contribution[];
}

export interface GradeSignal {
	signal: 'role_experience' | 'responsibility_marker' | 'level_test';
	[parameter: string]: unknown;
}

export interface NextGradeRequirement {
	code: 'role_experience' | 'responsibility_marker' | 'level_test' | 'role_skills';
	[parameter: string]: unknown;
}

export interface GradeExplanation {
	status: AxisStatus;
	scope: 'role' | 'role_family' | 'all_experience';
	signals: GradeSignal[];
	/** Evidence that exists but by the rules does not move a grade (FSP results, ranks, team roles). */
	ignored: { code: string; fact_ids: string[] }[];
	disagreements: { source: 'role_experience' | 'level_test'; grade_min: string; grade_max: string; fact_id?: string }[];
	missing: MissingItem[];
	/** What to add for the next grade: tied to concrete requirements, not a promise of promotion. */
	next_grade: { target: string; requirements: NextGradeRequirement[] } | null;
}

export interface StackExplanation {
	status: AxisStatus;
	skills: {
		skill_key: string;
		strength: number;
		band: StrengthBand;
		attestation: Attestation;
		badge_trust: TrustLevel | null;
		/** The contribution that counts in each group of dependent evidence. */
		grounds: Contribution[];
	}[];
	missing: MissingItem[];
}

export interface DesiredRoleExplanation {
	role_key: string;
	status: 'primary' | 'secondary' | 'not_inferred' | 'unknown_role';
	score: number | null;
	unconfirmed_core_groups: string[][];
	role_evidence: number | null;
}

export interface AssignmentExplanation {
	ruleset_version: number;
	taxonomy_version: string;
	role: RoleExplanation | { status: 'insufficient_data'; missing: MissingItem[] };
	grade: GradeExplanation;
	stack: StackExplanation;
	/** Desired roles against the inferred ones (primary assignment only). */
	desired_roles: DesiredRoleExplanation[];
	/** Markers from FSP team roles: shown, never a grade signal. */
	fsp_markers: { marker: Marker; fact_id: string; claim_id: string; weight: number }[];
}

/** Explanation of an operator's decision on a dispute: it replaces the calculation, not its grounds. */
export interface ManualOverrideExplanation {
	origin: 'manual_override';
	dispute_id: string;
	previous_run_id: string;
	ruleset_version: number;
	taxonomy_version: string;
}

export interface FspLevelResult {
	discipline: string;
	level: FspLevel;
	basisFactIds: string[];
	lastResultOn: string | null;
}

export interface CategorizationResult {
	outcome: 'complete' | 'partial' | 'insufficient_data';
	assignments: AssignmentResult[];
	missing: MissingByAxis;
	experienceSummary: ExperienceSummary;
	inferences: SkillInference[];
	fspLevels: FspLevelResult[];
	/** Facts and claims in the snapshot the rules gave no weight, with the reason. */
	unused: { fact_id: string; claim_id: string | null; code: string }[];
}
