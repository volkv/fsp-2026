// `matchScore(vacancy, candidate, ruleset)` (docs/domain.md, section 13.4): a pure function over snapshots, the same
// in both directions. Each component carries a status; computed components enter the weighted score, unknowns are
// explained instead of being penalized. The one exception is a candidate without a usable evidence run: the
// components of the evidence itself (`scoredWithoutValue`) keep their weight at the rule set's
// `unavailableEvidenceValue` instead of dropping out. At 0, as shipped, such a profile scores on them as one whose
// evidence was read and covers none of the vacancy's skills; the other components still count, so it can outrank a
// read profile that loses on role, grade or salary.
import { scoredWithoutValue, type EvidenceUnavailableReason } from '$lib/matching/evidence-components';
import {
	blockDefinition,
	CATALOG,
	gradeDefinition,
	gradeOrdinal,
	PRACTICE_LANGUAGE_SKILLS,
	type GradeKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import { specializationsOfRole } from '$lib/server/categories/roles';
import { compareSalary, type SalaryComparison, type SalaryTerms } from '$lib/server/salary/compare';
import type { ComponentKey, ComponentStatus, MatchRulesetParams } from './params';
import type { TestBlockResult } from './test-results';

export type StrengthBand = 'weak' | 'moderate' | 'strong';
export type Attestation = 'direct' | 'derived' | 'claimed';
export type TrustLevel = 'fsp_verified' | 'platform_verified' | 'public_verifiable' | 'claimed';

export interface GradeRange {
	min: string;
	max: string;
}

export interface MatchVacancy {
	roleKey: string | null;
	grade: GradeRange | null;
	requiredSkillKeys: readonly string[];
	niceSkillKeys: readonly string[];
	salary: SalaryTerms;
}

/** One skill inference of the candidate's valid evidence run. */
export interface SkillEvidence {
	skillKey: string;
	band: StrengthBand;
	attestation: Attestation;
	badgeTrust: TrustLevel | null;
	/** Facts behind the inference that are active at the moment of reading. Internal ids: never shown to a company. */
	factIds: readonly string[];
}

/** A category in force of the candidate (domain 12.4), as matching reads it. */
export interface CandidateCategory {
	specialization: SpecializationKey;
	grade: GradeKey;
}

/**
 * Evidence from the published evidence run. The run is unusable when there is none or when evidence was withdrawn
 * after it (`input_revision < evidence_floor_revision`, domain 17.3): then the skills are unavailable until the
 * recomputation, and nothing from the withdrawn evidence can reach the score. The category is apart from it.
 */
export type CandidateEvidence =
	| { status: 'available'; runId: string; skills: readonly SkillEvidence[] }
	| { status: 'unavailable'; reason: EvidenceUnavailableReason };

export interface MatchCandidate {
	evidence: CandidateEvidence;
	/** Categories in force (`activeCategories`): the specialization and the grade a test confirmed. */
	categories: readonly CandidateCategory[];
	salaryExpectation: SalaryTerms | null;
}

/** A model-based signal of the pair; `unavailable` carries the reason (switched off, no vector, not ranked). */
export type SemanticSignal =
	{ status: 'computed'; cosine: number; spaceId: string } | { status: 'unavailable'; reason: string };
export type RerankerSignal =
	{ status: 'computed'; score: number; modelId: string } | { status: 'unavailable'; reason: string };

export interface MatchInput {
	vacancy: MatchVacancy;
	candidate: MatchCandidate;
	params: MatchRulesetParams;
	/** Ordinals of the grades of the taxonomy version. */
	gradeOrdinals: ReadonlyMap<string, number>;
	semantic: SemanticSignal;
	reranker: RerankerSignal;
}

export interface SkillCoverage {
	skill_key: string;
	band: StrengthBand | null;
	attestation: Attestation | null;
	badge_trust: TrustLevel | null;
	value: number;
}

export interface SalaryUnit {
	currency: string | null;
	period: SalaryTerms['period'];
	tax_base: SalaryTerms['taxBase'];
}

export interface ComponentDetails {
	required: { skills?: SkillCoverage[]; reason?: string };
	nice: { skills?: SkillCoverage[]; reason?: string };
	/** What a computed trust rests on; one that is not computed carries only its reason. */
	trust: TrustBasis | { reason: string };
	grade: {
		vacancy?: GradeRange;
		candidate?: GradeRange;
		position?: 'within' | 'below' | 'above';
		steps?: number;
		reason?: string;
	};
	salary: { comparison?: SalaryComparison; vacancy?: SalaryUnit; candidate?: SalaryUnit; reason?: string };
	semantic: { cosine?: number; space_id?: string; reason?: string };
	reranker: { score?: number; model_id?: string; reason?: string };
	role: {
		/** The role of the vacancy and the specializations of the catalog it maps to (domain 12.10). */
		vacancy?: string;
		specializations?: SpecializationKey[];
		/** Specializations of the candidate's categories in force. */
		candidate?: SpecializationKey[];
		/** A category of the vacancy's specialization, or only of another one. */
		basis?: RoleBasis;
		reason?: string;
	};
}

export type RoleBasis = 'same_specialization' | 'other_specialization';

interface TrustBasis {
	/** Required skills confirmed by an FSP result or a platform test, of all required ones. */
	direct: number;
	total: number;
	/** Required skills that only a verified public profile attests: shown with its badge, not counted as confirmed. */
	public_profile: number;
	/** Share of the required skills covered by confirmed inferences, by their band. */
	confirmed_coverage: number;
	/** Share of the candidate's grade range inside the vacancy's; `null` — see `grade_agreement_reason`. */
	grade_agreement: number | null;
	grade_agreement_reason?: 'candidate_grade_not_confirmed' | 'vacancy_grade_unknown';
	reason?: never;
}

export interface MatchComponent<K extends ComponentKey = ComponentKey> {
	value: number | null;
	weight: number;
	status: ComponentStatus;
	details: ComponentDetails[K];
}

export type MatchComponents = { [K in ComponentKey]: MatchComponent<K> };

export type ExplanationMatch =
	| {
			kind: 'skill';
			requirement: 'required' | 'nice';
			skill_key: string;
			band: StrengthBand;
			attestation: Attestation;
			badge_trust: TrustLevel | null;
			/** Internal fact ids; a company sees receipts issued for it instead (domain 9.6, 14). */
			fact_ids: string[];
	  }
	| { kind: 'role'; role_key: string }
	| { kind: 'grade'; vacancy: GradeRange; candidate: GradeRange }
	| { kind: 'salary'; comparison: 'lower' | 'equal' | 'overlap' };

export interface ExplanationUnknown {
	component: ComponentKey;
	status: Exclude<ComponentStatus, 'computed'>;
	reason: string;
}

/** What to check at the interview: codes, the interface words them. */
export type VerifyItem =
	| { code: 'skill_claimed' | 'skill_derived' | 'skill_weak_evidence'; skill_key: string }
	| {
			code:
				| 'category_not_confirmed'
				| 'salary_not_comparable'
				| 'salary_expectation_missing'
				| 'profile_recalculating'
				| 'profile_insufficient_data';
	  };

/** Requirements that are not met and what to improve. */
export type GapItem =
	| { code: 'required_skill_missing' | 'nice_skill_missing'; skill_key: string }
	| { code: 'grade_below'; steps: number }
	| { code: 'specialization_other' };

export interface MatchExplanation {
	matches: ExplanationMatch[];
	unknown: ExplanationUnknown[];
	to_verify: VerifyItem[];
	gaps: GapItem[];
}

export interface MatchResult {
	/**
	 * Weighted mean of the computed components and, for a candidate without a usable run, of the evidence components at
	 * `unavailableEvidenceValue`; rounded to `numeric(4,3)`; 0 when nothing could be computed.
	 */
	score: number;
	/** Share of the total weight that was computed: how much of the rule set the score rests on. */
	coverage: number;
	components: MatchComponents;
	explanation: MatchExplanation;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function ordinalOf(ordinals: ReadonlyMap<string, number>, key: string): number {
	const ordinal = ordinals.get(key);
	if (ordinal === undefined) throw new Error(`grade ${key} is not in the taxonomy version`);
	return ordinal;
}

function skillCoverage(
	keys: readonly string[],
	skills: ReadonlyMap<string, SkillEvidence>,
	params: MatchRulesetParams
): SkillCoverage[] {
	return keys.map((key) => {
		const skill = skills.get(key);
		return skill
			? {
					skill_key: key,
					band: skill.band,
					attestation: skill.attestation,
					badge_trust: skill.badgeTrust,
					value: params.skillBandValue[skill.band]
				}
			: { skill_key: key, band: null, attestation: null, badge_trust: null, value: 0 };
	});
}

/**
 * Trust levels that confirm a skill: an FSP result and a platform test. A verified public profile attests a skill
 * directly and keeps its own badge, but it is the candidate's public account, not a check of the skill: repository
 * languages do not prove authorship, a rating is another platform's record (domain 9.4). It covers a requirement like
 * any inference and never enters the trust or the pool of confirmed candidates.
 */
const CONFIRMING_TRUST: ReadonlySet<TrustLevel> = new Set(['fsp_verified', 'platform_verified']);

/** The inference confirms the skill: attested directly by a fact of a confirming trust level. */
function confirmsSkill(skill: Pick<SkillEvidence, 'attestation' | 'badgeTrust'>): boolean {
	return skill.attestation === 'direct' && skill.badgeTrust !== null && CONFIRMING_TRUST.has(skill.badgeTrust);
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function unitOf(terms: SalaryTerms): SalaryUnit {
	return { currency: terms.currency, period: terms.period, tax_base: terms.taxBase };
}

/** The specializations the vacancy's role maps to; `null` — the vacancy has no role. */
function vacancySpecializations(vacancy: MatchVacancy): readonly SpecializationKey[] | null {
	return vacancy.roleKey === null ? null : specializationsOfRole(vacancy.roleKey);
}

/**
 * The category of the candidate the vacancy is compared with (domain 13.4): the one of the vacancy's specialization —
 * the highest grade if the role maps to several; for a vacancy without a specialization, the candidate's highest
 * grade. `null` — no category, or none of the vacancy's specialization: the grade is unknown, never low.
 */
function comparedCategory(
	categories: readonly CandidateCategory[],
	specializations: readonly SpecializationKey[] | null,
	ordinals: ReadonlyMap<string, number>
): CandidateCategory | null {
	const eligible =
		specializations === null || specializations.length === 0
			? categories
			: categories.filter((c) => specializations.includes(c.specialization));
	return (
		[...eligible].sort(
			(a, b) =>
				ordinalOf(ordinals, b.grade) - ordinalOf(ordinals, a.grade) || (a.specialization < b.specialization ? -1 : 1)
		)[0] ?? null
	);
}

/**
 * Share of the candidate's grade range that lies inside the vacancy's: a range that sits inside is 1, a wide range
 * that only touches the vacancy's is a fraction, disjoint ranges are 0.
 */
function gradeAgreement(ordinals: ReadonlyMap<string, number>, vacancy: GradeRange, candidate: GradeRange): number {
	const vMin = ordinalOf(ordinals, vacancy.min);
	const vMax = ordinalOf(ordinals, vacancy.max);
	const cMin = ordinalOf(ordinals, candidate.min);
	const cMax = ordinalOf(ordinals, candidate.max);
	const inside = Math.max(0, Math.min(vMax, cMax) - Math.max(vMin, cMin) + 1);
	return inside / (cMax - cMin + 1);
}

export function matchScore(input: MatchInput): MatchResult {
	const { vacancy, candidate, params, gradeOrdinals } = input;
	const { weights } = params;
	const evidence = candidate.evidence;

	const component = <K extends ComponentKey>(
		key: K,
		status: ComponentStatus,
		value: number | null,
		details: ComponentDetails[K]
	): MatchComponent<K> => ({ value: status === 'computed' ? value : null, weight: weights[key], status, details });

	// Skills: coverage of required and nice-to-have skills by bands of the valid run.
	const skills = new Map(evidence.status === 'available' ? evidence.skills.map((s) => [s.skillKey, s]) : []);
	const skillComponent = <K extends 'required' | 'nice'>(key: K, keys: readonly string[]): MatchComponent<K> => {
		if (keys.length === 0) return component(key, 'unknown', null, { reason: `no_${key}_skills` });
		if (evidence.status === 'unavailable') return component(key, 'unavailable', null, { reason: evidence.reason });
		const coverage = skillCoverage(keys, skills, params);
		return component(key, 'computed', mean(coverage.map((c) => c.value)), { skills: coverage });
	};
	const required = skillComponent('required', vacancy.requiredSkillKeys);
	const nice = skillComponent('nice', vacancy.niceSkillKeys);

	const specializations = vacancySpecializations(vacancy);
	const compared = comparedCategory(candidate.categories, specializations, gradeOrdinals);
	const candidateRange: GradeRange | null = compared && { min: compared.grade, max: compared.grade };

	// Trust in the score: how much of the required skills rests on confirmations (an FSP result, a platform test), by
	// their band, and how well the candidate's grade range agrees with the vacancy's. A claim or a public profile covers a
	// requirement but does not confirm it; an unknown grade lowers the trust instead of being taken for a match.
	let trust: MatchComponent<'trust'>;
	if (vacancy.requiredSkillKeys.length === 0)
		trust = component('trust', 'unknown', null, { reason: 'no_required_skills' });
	else if (evidence.status === 'unavailable')
		trust = component('trust', 'unavailable', null, { reason: evidence.reason });
	else {
		const requiredSkills = vacancy.requiredSkillKeys.map((key) => skills.get(key));
		const confirmed = requiredSkills.flatMap((skill) =>
			skill !== undefined && confirmsSkill(skill) ? [params.skillBandValue[skill.band]] : []
		);
		const publicProfile = requiredSkills.filter(
			(skill) => skill?.attestation === 'direct' && skill.badgeTrust === 'public_verifiable'
		).length;
		const total = vacancy.requiredSkillKeys.length;
		const confirmedCoverage = confirmed.reduce((sum, value) => sum + value, 0) / total;
		// A vacancy without a grade asks for no agreement; a candidate without a compared category gets the rule set's.
		let agreement: number;
		let agreementDetails: Pick<TrustBasis, 'grade_agreement' | 'grade_agreement_reason'>;
		if (vacancy.grade === null) {
			agreement = 1;
			agreementDetails = { grade_agreement: null, grade_agreement_reason: 'vacancy_grade_unknown' };
		} else if (candidateRange === null) {
			agreement = params.trust.unknownGradeAgreement;
			agreementDetails = { grade_agreement: null, grade_agreement_reason: 'candidate_grade_not_confirmed' };
		} else {
			agreement = gradeAgreement(gradeOrdinals, vacancy.grade, candidateRange);
			agreementDetails = { grade_agreement: agreement };
		}
		const value = confirmedCoverage * (1 - params.trust.gradeWeight * (1 - agreement));
		trust = component('trust', 'computed', value, {
			direct: confirmed.length,
			total,
			public_profile: publicProfile,
			confirmed_coverage: confirmedCoverage,
			...agreementDetails
		});
	}

	// Role: the specialization of the vacancy's role against the specializations of the categories in force (13.4).
	const held = [...new Set(candidate.categories.map((c) => c.specialization))].sort();
	let role: MatchComponent<'role'>;
	if (vacancy.roleKey === null || specializations === null) {
		role = component('role', 'unknown', null, { reason: 'vacancy_role_unknown' });
	} else if (specializations.length === 0) {
		role = component('role', 'unknown', null, {
			vacancy: vacancy.roleKey,
			specializations: [],
			reason: 'vacancy_role_without_specialization'
		});
	} else if (held.length === 0) {
		role = component('role', 'unknown', null, {
			vacancy: vacancy.roleKey,
			specializations: [...specializations],
			candidate: [],
			reason: 'category_not_confirmed'
		});
	} else {
		const basis: RoleBasis = held.some((s) => specializations.includes(s))
			? 'same_specialization'
			: 'other_specialization';
		role = component('role', 'computed', basis === 'same_specialization' ? 1 : 0, {
			vacancy: vacancy.roleKey,
			specializations: [...specializations],
			candidate: held,
			basis
		});
	}

	// Grade: the vacancy's range against the confirmed grade; each step outside the range costs `stepPenalty`.
	let grade: MatchComponent<'grade'>;
	if (vacancy.grade === null) grade = component('grade', 'unknown', null, { reason: 'vacancy_grade_unknown' });
	else {
		if (candidateRange === null) {
			grade = component('grade', 'unknown', null, {
				vacancy: vacancy.grade,
				reason: held.length === 0 ? 'category_not_confirmed' : 'specialization_other'
			});
		} else {
			const vMin = ordinalOf(gradeOrdinals, vacancy.grade.min);
			const vMax = ordinalOf(gradeOrdinals, vacancy.grade.max);
			const cMin = ordinalOf(gradeOrdinals, candidateRange.min);
			const cMax = ordinalOf(gradeOrdinals, candidateRange.max);
			const position = cMax < vMin ? 'below' : cMin > vMax ? 'above' : 'within';
			const steps = position === 'below' ? vMin - cMax : position === 'above' ? cMin - vMax : 0;
			grade = component('grade', 'computed', Math.max(0, 1 - steps * params.grade.stepPenalty), {
				vacancy: vacancy.grade,
				candidate: candidateRange,
				position,
				steps
			});
		}
	}

	// Salary: compared only with the same currency, period and a known identical tax base (domain 0).
	let salary: MatchComponent<'salary'>;
	let comparison: SalaryComparison | null = null;
	const expectation = candidate.salaryExpectation;
	if (expectation === null || (expectation.min === null && expectation.max === null)) {
		salary = component('salary', 'unknown', null, { reason: 'candidate_expectation_missing' });
	} else if (vacancy.salary.min === null && vacancy.salary.max === null) {
		salary = component('salary', 'unknown', null, { reason: 'vacancy_salary_missing' });
	} else {
		comparison = compareSalary(expectation, vacancy.salary);
		const units = { vacancy: unitOf(vacancy.salary), candidate: unitOf(expectation) };
		salary =
			comparison === 'not_comparable'
				? component('salary', 'not_comparable', null, { ...units, comparison, reason: 'different_terms' })
				: component('salary', 'computed', params.salary[comparison], { ...units, comparison });
	}

	// Semantic similarity inside one embedding space.
	const { semantic: semanticSignal, reranker: rerankerSignal } = input;
	const semantic =
		semanticSignal.status === 'computed'
			? component(
					'semantic',
					'computed',
					Math.min(
						1,
						Math.max(0, (semanticSignal.cosine - params.semantic.minCosine) / (1 - params.semantic.minCosine))
					),
					{ cosine: semanticSignal.cosine, space_id: semanticSignal.spaceId }
				)
			: component('semantic', 'unavailable', null, { reason: semanticSignal.reason });

	// Reranker: one explicit component with its own weight.
	let reranker: MatchComponent<'reranker'>;
	if (rerankerSignal.status === 'unavailable') {
		reranker = component('reranker', 'unavailable', null, { reason: rerankerSignal.reason });
	} else if (params.reranker.scale === 'logit') {
		reranker = component('reranker', 'computed', 1 / (1 + Math.exp(-rerankerSignal.score)), {
			score: rerankerSignal.score,
			model_id: rerankerSignal.modelId
		});
	} else if (rerankerSignal.score < 0 || rerankerSignal.score > 1) {
		// A probability outside [0, 1] means the rule set does not describe this reranker: shown, not guessed.
		reranker = component('reranker', 'unavailable', null, {
			score: rerankerSignal.score,
			model_id: rerankerSignal.modelId,
			reason: 'score_outside_probability_scale'
		});
	} else {
		reranker = component('reranker', 'computed', rerankerSignal.score, {
			score: rerankerSignal.score,
			model_id: rerankerSignal.modelId
		});
	}

	const components: MatchComponents = { required, nice, role, trust, grade, salary, semantic, reranker };

	// Without a usable run the evidence components are unavailable, not unknown: they keep their weight at the rule set's
	// value, so a profile whose evidence was not read cannot rest its score on the salary alone.
	let weighted = 0;
	let scoredWeight = 0;
	let computedWeight = 0;
	let totalWeight = 0;
	for (const [key, entry] of Object.entries(components) as [ComponentKey, MatchComponent][]) {
		totalWeight += entry.weight;
		if (entry.status === 'computed' && entry.value !== null) {
			weighted += entry.weight * entry.value;
			scoredWeight += entry.weight;
			computedWeight += entry.weight;
		} else if (scoredWithoutValue(key, entry)) {
			weighted += entry.weight * params.unavailableEvidenceValue;
			scoredWeight += entry.weight;
		}
	}
	const score = scoredWeight > 0 ? round3(weighted / scoredWeight) : 0;

	return {
		score,
		coverage: round3(computedWeight / totalWeight),
		components,
		explanation: explain(input, components, candidateRange, comparison)
	};
}

function explain(
	input: MatchInput,
	components: MatchComponents,
	candidateRange: GradeRange | null,
	comparison: SalaryComparison | null
): MatchExplanation {
	const { vacancy, candidate } = input;
	const evidence = candidate.evidence;
	const matches: ExplanationMatch[] = [];
	const toVerify: VerifyItem[] = [];
	const gaps: GapItem[] = [];

	if (evidence.status === 'available') {
		const skills = new Map(evidence.skills.map((s) => [s.skillKey, s]));
		const requirements = [
			...vacancy.requiredSkillKeys.map((key) => ['required', key] as const),
			...vacancy.niceSkillKeys.map((key) => ['nice', key] as const)
		];
		for (const [requirement, key] of requirements) {
			const skill = skills.get(key);
			if (!skill) {
				gaps.push({
					code: requirement === 'required' ? 'required_skill_missing' : 'nice_skill_missing',
					skill_key: key
				});
				continue;
			}
			matches.push({
				kind: 'skill',
				requirement,
				skill_key: key,
				band: skill.band,
				attestation: skill.attestation,
				badge_trust: skill.badgeTrust,
				fact_ids: [...skill.factIds]
			});
			if (skill.attestation === 'claimed') toVerify.push({ code: 'skill_claimed', skill_key: key });
			else if (skill.attestation === 'derived') toVerify.push({ code: 'skill_derived', skill_key: key });
			if (skill.band === 'weak') toVerify.push({ code: 'skill_weak_evidence', skill_key: key });
		}
	} else if (evidence.reason === 'run_below_evidence_floor') {
		toVerify.push({ code: 'profile_recalculating' });
	} else {
		// No published category: never computed yet, or blocked until the recomputation after a withdrawal.
		toVerify.push({ code: 'profile_insufficient_data' });
	}

	const role = components.role;
	if (vacancy.roleKey !== null && role.details.basis === 'same_specialization') {
		matches.push({ kind: 'role', role_key: vacancy.roleKey });
	}
	if (role.details.basis === 'other_specialization') gaps.push({ code: 'specialization_other' });
	// Without a category in force the candidate is in the base, not in a category (domain 12.7): to be checked.
	if (candidate.categories.length === 0) toVerify.push({ code: 'category_not_confirmed' });

	const grade = components.grade;
	if (grade.status === 'computed' && vacancy.grade !== null && candidateRange !== null) {
		if (grade.details.position === 'within')
			matches.push({ kind: 'grade', vacancy: vacancy.grade, candidate: candidateRange });
		if (grade.details.position === 'below') gaps.push({ code: 'grade_below', steps: grade.details.steps ?? 0 });
	}

	if (comparison === 'lower' || comparison === 'equal' || comparison === 'overlap') {
		matches.push({ kind: 'salary', comparison });
	}
	if (comparison === 'not_comparable') toVerify.push({ code: 'salary_not_comparable' });
	if (components.salary.details.reason === 'candidate_expectation_missing') {
		toVerify.push({ code: 'salary_expectation_missing' });
	}

	const unknown: ExplanationUnknown[] = [];
	for (const [key, entry] of Object.entries(components) as [ComponentKey, MatchComponent][]) {
		if (entry.status === 'computed') continue;
		unknown.push({ component: key, status: entry.status, reason: entry.details.reason ?? entry.status });
	}

	return { matches, unknown, to_verify: toVerify, gaps };
}

/**
 * The pair counts for «in the pool N confirmed candidates» (domain 13.3): the score reaches the pool threshold and at
 * least one required skill is confirmed by an FSP result or a platform test (`confirmsSkill`) — the trust component is
 * computed and above zero (a band is always worth more than zero and the grade agreement never takes all of the trust,
 * so the trust is zero exactly when no required skill is confirmed; a public profile alone leaves it at zero). It reads only the score and the component values, so a stored decomposition
 * decides it the same way. Visibility of the candidate is checked separately.
 */
export function qualifiesForPool(
	score: number,
	trust: Pick<MatchComponent<'trust'>, 'status' | 'value'>,
	params: MatchRulesetParams
): boolean {
	return score >= params.poolThreshold && trust.status === 'computed' && (trust.value ?? 0) > 0;
}

// --- Ranking for a hiring need and the strength of the confirmed profile (domain 13.10) ------------------------------
//
// Above everything, the grade: a candidate holding a category of the need is above every candidate who holds none — the
// group «грейд не подтверждён» of a shortlist, the candidates whose own declaration names a category of the need
// (`group`). The declaration is a filter and a label, never evidence: inside the group the same levels order, a claim
// capped as a claim of a skill the declared category's test checks.
// Then two levels. The first is the coverage of the required skills: a candidate whose every required skill a test, an
// FSP result or the platform confirmed covers the need; another has N of M required skills unconfirmed, and each of
// them says what there is instead — a verified public profile, the candidate's words, nothing, or nothing known while
// the profile is being recalculated. The ranking orders by the number of unconfirmed required skills first
// (`coverage`); for a composite role (fullstack) a candidate confirmed in every specialization of the role comes next
// (`composite`). The second is the score inside a group: the fit to the need (its skills by the best basis of each, the
// work format) and the strength of the confirmed profile (the test by blocks, the FSP record — competitions and
// podiums, every competition of one weight — and how recent the last confirmed action is), additive. The denominator
// is the weight of the components the need asks for — the same for every candidate of the need — so a contribution is
// `weight × value / denominator`, exactly, and the absence of FSP is the absence of its bonus, never a penalty. The
// catalog without a need ranks by the strength level alone. The salary expectation of a candidate is hidden from a
// company and never enters a score a company sees (domain 13.10).

export const NEED_COMPONENT_KEYS = ['required', 'nice', 'format', 'test', 'fsp', 'freshness'] as const;
export type NeedComponentKey = (typeof NEED_COMPONENT_KEYS)[number];

/** The level of a component: the fit to the need or the strength of the confirmed profile. */
export const NEED_LEVEL: Readonly<Record<NeedComponentKey, 'need' | 'strength'>> = {
	required: 'need',
	nice: 'need',
	format: 'need',
	test: 'strength',
	fsp: 'strength',
	freshness: 'strength'
};

export type NeedWorkFormat = 'office' | 'hybrid' | 'remote';

/** What the ranking reads of a need; `categories` — the categories of the shortlist the candidate is ranked in. */
export interface NeedSpec {
	requiredSkillKeys: readonly string[];
	niceSkillKeys: readonly string[];
	workFormat: NeedWorkFormat | null;
	regionCode: string | null;
	/** `false` — the employer said results of FSP do not matter for the need: the FSP component is out of its score. */
	fspRelevant: boolean;
	/**
	 * The categories of the shortlist. A candidate holding one of them is confirmed; one who holds none is of the group
	 * «грейд не подтверждён», admitted by their own declaration of one of them.
	 */
	categories: readonly CandidateCategory[];
	/**
	 * The specializations of a composite role of the need (fullstack: backend and frontend); empty for any other. A
	 * candidate with a category in force in each of them covers the whole work of the role.
	 */
	compositeSpecializations: readonly SpecializationKey[];
}

/** A category in force with what its test confirmed (domain 12.4). */
export interface ConfirmedCategory extends CandidateCategory {
	decisionId: string;
	confirmedBlocks: readonly string[];
	confirmedSkillKeys: readonly string[];
	assignedAt: Date;
}

/** The blocks of the candidate's decisions, by decision id; a decision without them is absent. */
export type CandidateTestResults = ReadonlyMap<string, readonly TestBlockResult[]>;

/**
 * An official result of an FSP competition in force, the candidate's own: a team result of a member who competed. The
 * FSP record counts them (`fspRecord`).
 */
export interface FspResult {
	/** Internal id of the fact: a company sees the receipts of the card instead. */
	factId: string;
	competitionId: string;
	/** A win or a prize. */
	podium: boolean;
	/** A result of the team: a podium of the team is the team's result, not a confirmation of a skill. */
	team: boolean;
}

export interface NeedCandidate {
	evidence: CandidateEvidence;
	categories: readonly ConfirmedCategory[];
	/** The declaration in force of each specialization: what the candidate says of their grade, never evidence. */
	declared: readonly CandidateCategory[];
	fspResults: readonly FspResult[];
	/** What the card shows of the preferences: formats, region, readiness to relocate. */
	preferences: { workFormats: readonly string[]; regionCode: string | null; relocation: boolean | null };
	tests: CandidateTestResults;
	/**
	 * The latest confirmed action besides the assignment of a category — a valid result of a block test or a submitted
	 * solution of a call (domain 13.12); `null` — none. Freshness counts from the latest of it and the categories.
	 */
	lastConfirmedAction: Date | null;
}

export interface NeedScoreInput {
	/** `null` — the catalog without a need: the strength level alone. */
	need: NeedSpec | null;
	candidate: NeedCandidate;
	params: MatchRulesetParams['need'];
	skillBandValue: MatchRulesetParams['skillBandValue'];
	now: Date;
	/** Score the candidate as if they had no FSP results: «без ФСП — позиция N». */
	withoutFsp?: boolean;
}

/**
 * The best basis of a skill of the need; `claimed` covers a derivation from the resume too. `claimed` — a claim of a
 * skill the candidate's own test checks (a block or the practice language of the grade they passed) and did not
 * confirm; `claimed_untestable` — a claim of a skill their test does not check: the resume is the best evidence there
 * is. `missing` — the read profile has nothing of the skill; `unknown` — the profile is not readable now (none
 * published, or evidence withdrawn after it), so its absence is not known.
 */
export type SkillBasis =
	'test' | 'fsp' | 'platform' | 'public_profile' | 'claimed_untestable' | 'claimed' | 'missing' | 'unknown';

/** What stands for a required skill no test, FSP result or platform confirmed. */
export type UnconfirmedState = 'public_profile' | 'claimed' | 'missing' | 'unknown';

/** The first level: the required skills of the need and those not confirmed. */
export interface NeedCoverage {
	/** `covers` — every required skill is confirmed (or the need names none); `gaps` — some are not. */
	group: 'covers' | 'gaps';
	required: number;
	unconfirmed: { skill_key: string; state: UnconfirmedState }[];
}

export interface SkillReading {
	skill_key: string;
	requirement: 'required' | 'nice';
	basis: SkillBasis;
	value: number;
	band: StrengthBand | null;
	/** The block of the test that confirmed the skill (`basis = test`). */
	block: string | null;
	/** Internal fact ids of the inference: a company sees receipts instead. */
	fact_ids: string[];
}

export interface NeedComponent {
	level: 'need' | 'strength';
	/** The need asks for the component; one it does not ask for has no weight in any score of the need. */
	applicable: boolean;
	status: 'computed' | 'unknown' | 'unavailable';
	/** The value the score counts with: computed, or the rule set's value for an unknown. */
	value: number;
	weight: number;
	/** `weight × value / denominator`. */
	contribution: number;
	reason: string | null;
}

/** Where a reason of «почему подходит» comes from; the offer takes the transferable ones into «почему вы» (13.5). */
export type NeedReasonSource =
	| { kind: 'test_block'; ref: string; specialization: SpecializationKey; grade: GradeKey }
	| { kind: 'fsp_fact'; fact_ids: string[] }
	| { kind: 'evidence'; fact_ids: string[] }
	| { kind: 'declared_skill'; ref: string }
	| { kind: 'preference'; ref: 'work_formats' | 'region_code' | 'relocation' };

/** Skills of the need grouped by their basis. */
export interface SkillsReason {
	code:
		| 'skills_test'
		| 'skills_fsp'
		| 'skills_platform'
		| 'skills_public_profile'
		| 'skills_claimed_untestable'
		| 'skills_claimed';
	skill_keys: string[];
	contribution: number;
	source: NeedReasonSource;
}

export type NeedReason =
	| SkillsReason
	| {
			code: 'test_result';
			specialization: SpecializationKey;
			grade: GradeKey;
			/** Mean shrunk margin over the blocks, per item: 0 — exactly at the cut. */
			margin: number;
			contribution: number;
			source: NeedReasonSource;
	  }
	| {
			code: 'fsp_record';
			/** Distinct FSP competitions with an official result of the candidate. */
			competitions: number;
			/** Of them, with a win or a prize; `team_podiums` — those only a team result put there. */
			podiums: number;
			team_podiums: number;
			contribution: number;
			source: NeedReasonSource;
	  }
	| { code: 'format_fits'; format: NeedWorkFormat; contribution: number; source: NeedReasonSource }
	| { code: 'confirmed_recently'; days: number; contribution: number; source: NeedReasonSource };

/** A composite role: its specializations and those the candidate holds a category in force of. */
export interface NeedComposite {
	specializations: SpecializationKey[];
	held: SpecializationKey[];
	complete: boolean;
}

/** The FSP record of a candidate (the FSP component, domain 13.10). */
export interface FspRecord {
	competitions: number;
	podiums: number;
	team_podiums: number;
	value: number;
	/** Internal ids of the counted results: a company sees the receipts of the card. */
	fact_ids: string[];
}

/**
 * The FSP record over the candidate's official results: distinct competitions `N`, those with a podium `M` (a
 * competition counts once, as a podium if any of its results is one, as a team podium only if no result of the
 * candidate's own put it there), every competition of one weight; the value saturates in both (rule set, `need.fsp`).
 */
export function fspRecord(results: readonly FspResult[], params: MatchRulesetParams['need']['fsp']): FspRecord {
	const byCompetition = new Map<string, { podium: boolean; individualPodium: boolean }>();
	for (const result of results) {
		const seen = byCompetition.get(result.competitionId) ?? { podium: false, individualPodium: false };
		byCompetition.set(result.competitionId, {
			podium: seen.podium || result.podium,
			individualPodium: seen.individualPodium || (result.podium && !result.team)
		});
	}
	const competitions = byCompetition.size;
	const podiums = [...byCompetition.values()].filter((c) => c.podium).length;
	const teamPodiums = [...byCompetition.values()].filter((c) => c.podium && !c.individualPodium).length;
	const saturated = (count: number, half: number) => 1 - Math.pow(2, -count / half);
	const value =
		params.participationShare * saturated(competitions, params.competitionsHalf) +
		(1 - params.participationShare) * saturated(podiums, params.podiumsHalf);
	return {
		competitions,
		podiums,
		team_podiums: teamPodiums,
		value,
		fact_ids: [...new Set(results.map((result) => result.factId))]
	};
}

export interface NeedResult {
	/**
	 * Above the coverage: `confirmed` — the candidate holds a category of the need's (any, in the catalog without a
	 * need); `unconfirmed` — none, the group «грейд не подтверждён», after every confirmed candidate.
	 */
	group: 'confirmed' | 'unconfirmed';
	/** For the unconfirmed of a need: the category of the need their own declaration names — a label, not evidence. */
	declared: CandidateCategory | null;
	/** The FSP record the FSP component counts; `null` — the need leaves FSP out, or it is scored without FSP. */
	fsp: Omit<FspRecord, 'value' | 'fact_ids'> | null;
	/** The first level: the order goes by the number of unconfirmed required skills before the score. */
	coverage: NeedCoverage;
	/** For a composite role; `null` — the need's role is of one specialization or none. */
	composite: NeedComposite | null;
	/** The order inside a group of coverage. */
	score: number;
	/** The sum of the contributions of each level. */
	levels: { need: number; strength: number };
	components: Record<NeedComponentKey, NeedComponent>;
	skills: SkillReading[];
	/** 3–5 strongest positive contributions, each with its source. */
	reasons: NeedReason[];
	/** Required skills with no basis at all. */
	gaps: string[];
	/** Skills of the need resting only on the candidate's words: to check at the interview. */
	toVerify: string[];
	/** The category the strength is read from; `null` — none of the shortlist's categories (or none at all). */
	category: ConfirmedCategory | null;
}

const REASONS_MAX = 5;
const BASIS_ORDER: readonly SkillBasis[] = [
	'test',
	'fsp',
	'platform',
	'public_profile',
	'claimed_untestable',
	'claimed',
	'missing',
	'unknown'
];
const DAY_MS = 86_400_000;

function blockOfSkill(category: ConfirmedCategory, skillKey: string): string {
	const block = category.confirmedBlocks.find((code) => blockDefinition(code).skillKeys.includes(skillKey));
	return block ?? gradeDefinition(category.specialization, category.grade).practice.block;
}

/**
 * Skills the candidate's own tests check: the skills of the blocks of the grades of their categories in force and the
 * practice languages of those specializations — and, of the group «грейд не подтверждён», of the category they declared:
 * its test checks them, whether the candidate has not taken it or has not passed it. A claim of such a skill was put to
 * the check, or is to be put to it, and stands unconfirmed.
 */
function checkedByOwnTests(categories: readonly CandidateCategory[]): Set<string> {
	const checked = new Set<string>();
	for (const category of categories) {
		for (const quota of gradeDefinition(category.specialization, category.grade).blocks) {
			for (const skill of blockDefinition(quota.block).skillKeys) checked.add(skill);
		}
		for (const language of CATALOG.specializations.find((s) => s.key === category.specialization)?.practiceLanguages ??
			[]) {
			checked.add(PRACTICE_LANGUAGE_SKILLS[language]);
		}
	}
	return checked;
}

/**
 * The best basis of each skill: the test's confirmed stack, then confirmations by trust, then what was claimed. A claim
 * is worth its band times a ceiling — lower when the candidate's own test checks the skill — so a stronger claim stays
 * stronger and no claim reaches a check.
 */
function readSkill(
	skillKey: string,
	requirement: 'required' | 'nice',
	candidate: NeedCandidate,
	skills: ReadonlyMap<string, SkillEvidence>,
	checked: ReadonlySet<string>,
	input: Pick<NeedScoreInput, 'params' | 'skillBandValue' | 'withoutFsp'>
): SkillReading {
	const options: SkillReading[] = [];
	const tested = candidate.categories.find((category) => category.confirmedSkillKeys.includes(skillKey));
	if (tested) {
		options.push({
			skill_key: skillKey,
			requirement,
			basis: 'test',
			value: input.params.skill.test,
			band: null,
			block: blockOfSkill(tested, skillKey),
			fact_ids: []
		});
	}
	const inference = skills.get(skillKey);
	if (inference) {
		const band = input.skillBandValue[inference.band];
		const trust = inference.attestation === 'direct' ? inference.badgeTrust : null;
		let basis: SkillBasis;
		let value: number;
		if (trust === 'fsp_verified') [basis, value] = ['fsp', band];
		else if (trust === 'platform_verified') [basis, value] = ['platform', band];
		else if (trust === 'public_verifiable')
			[basis, value] = ['public_profile', band * input.params.skill.publicProfileFactor];
		else if (checked.has(skillKey)) [basis, value] = ['claimed', band * input.params.skill.claimedCeiling];
		else [basis, value] = ['claimed_untestable', band * input.params.skill.untestableClaimedCeiling];
		if (!(basis === 'fsp' && input.withoutFsp)) {
			options.push({
				skill_key: skillKey,
				requirement,
				basis,
				value,
				band: inference.band,
				block: null,
				fact_ids: [...inference.factIds]
			});
		}
	}
	const best = options.sort(
		(a, b) => b.value - a.value || BASIS_ORDER.indexOf(a.basis) - BASIS_ORDER.indexOf(b.basis)
	)[0];
	if (best) return best;
	const basis = candidate.evidence.status === 'available' ? 'missing' : 'unknown';
	return { skill_key: skillKey, requirement, basis, value: 0, band: null, block: null, fact_ids: [] };
}

const CONFIRMED_BASES: ReadonlySet<SkillBasis> = new Set(['test', 'fsp', 'platform']);

function coverageOf(required: readonly SkillReading[]): NeedCoverage {
	const unconfirmed = required
		.filter((skill) => !CONFIRMED_BASES.has(skill.basis))
		.map((skill) => ({
			skill_key: skill.skill_key,
			state: (skill.basis === 'claimed_untestable' ? 'claimed' : skill.basis) as UnconfirmedState
		}));
	return { group: unconfirmed.length === 0 ? 'covers' : 'gaps', required: required.length, unconfirmed };
}

/** The category the strength is read from: of the shortlist's categories (or any), the highest grade. */
function strengthCategory(
	categories: readonly ConfirmedCategory[],
	wanted: readonly CandidateCategory[] | null
): ConfirmedCategory | null {
	const eligible =
		wanted === null || wanted.length === 0
			? categories
			: categories.filter((c) => wanted.some((w) => w.specialization === c.specialization && w.grade === c.grade));
	return (
		[...eligible].sort(
			(a, b) => gradeOrdinal(b.grade) - gradeOrdinal(a.grade) || a.specialization.localeCompare(b.specialization)
		)[0] ?? null
	);
}

interface TestReading {
	status: NeedComponent['status'];
	value: number;
	reason: string | null;
	margin: number | null;
	strongestBlock: string | null;
}

/** The result of the test by blocks; blocks confirming skills of the need weigh more. */
function readTest(
	category: ConfirmedCategory | null,
	tests: CandidateTestResults,
	needSkills: ReadonlySet<string>,
	params: MatchRulesetParams['need']['test']
): TestReading {
	if (category === null)
		return { status: 'computed', value: 0, reason: 'no_category', margin: null, strongestBlock: null };
	const blocks = tests.get(category.decisionId);
	if (!blocks || blocks.length === 0) {
		return {
			status: 'unavailable',
			value: params.unknownValue,
			reason: 'test_result_missing',
			margin: null,
			strongestBlock: category.confirmedBlocks[0] ?? null
		};
	}
	let weighted = 0;
	let weights = 0;
	let strongest: { block: string; margin: number } | null = null;
	for (const block of blocks) {
		const margin =
			((block.score - block.cut) / (20 * block.items)) * (block.items / (block.items + params.shrinkItems));
		const related = CATALOG.blocks
			.find((b) => b.code === block.block)
			?.skillKeys.some((skill) => needSkills.has(skill));
		const weight = block.items * (related ? params.needBlockFactor : 1);
		weighted += weight * margin;
		weights += weight;
		if (strongest === null || margin > strongest.margin) strongest = { block: block.block, margin };
	}
	const margin = weighted / weights;
	return {
		status: 'computed',
		value: Math.min(1, Math.max(0, 0.5 + params.marginScale * margin)),
		reason: null,
		margin,
		strongestBlock: strongest?.block ?? null
	};
}

function readFormat(
	need: NeedSpec,
	preferences: NeedCandidate['preferences'],
	params: MatchRulesetParams['need']['format']
): { status: NeedComponent['status']; value: number; reason: string | null } {
	const format = need.workFormat;
	if (format === null) throw new Error('the format is read only for a need with a format');
	if (preferences.workFormats.length === 0) {
		return { status: 'unknown', value: params.unknownValue, reason: 'candidate_formats_unknown' };
	}
	if (!preferences.workFormats.includes(format)) return { status: 'computed', value: 0, reason: 'format_other' };
	if (format === 'remote' || need.regionCode === null) return { status: 'computed', value: 1, reason: null };
	if (preferences.regionCode === need.regionCode) return { status: 'computed', value: 1, reason: null };
	if (preferences.relocation === true) return { status: 'computed', value: params.relocation, reason: 'relocation' };
	if (preferences.regionCode === null) {
		return { status: 'unknown', value: params.unknownValue, reason: 'candidate_region_unknown' };
	}
	return { status: 'computed', value: 0, reason: 'region_other' };
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

export function needScore(input: NeedScoreInput): NeedResult {
	const { need, candidate, params, now } = input;
	const evidence = candidate.evidence;
	const skills = new Map(evidence.status === 'available' ? evidence.skills.map((s) => [s.skillKey, s]) : []);
	// The category the strength is read from: one of the need's, or none — the group «грейд не подтверждён», labelled by
	// the category of the need the candidate declared.
	const category = strengthCategory(candidate.categories, need?.categories ?? null);
	const group = category === null ? 'unconfirmed' : 'confirmed';
	const declared =
		need === null || group === 'confirmed'
			? null
			: (candidate.declared.find((d) =>
					need.categories.some((c) => c.specialization === d.specialization && c.grade === d.grade)
				) ?? null);
	// Skills the candidate's own test checks: a claim of one of them is capped low, as the check did not confirm it.
	const checked = checkedByOwnTests(declared === null ? candidate.categories : [...candidate.categories, declared]);
	const required = (need?.requiredSkillKeys ?? []).map((key) =>
		readSkill(key, 'required', candidate, skills, checked, input)
	);
	const nice = (need?.niceSkillKeys ?? [])
		.filter((key) => !need?.requiredSkillKeys.includes(key))
		.map((key) => readSkill(key, 'nice', candidate, skills, checked, input));
	const needSkills = new Set([...required, ...nice].map((s) => s.skill_key));
	const test = readTest(category, candidate.tests, needSkills, params.test);

	// The FSP record: every official result of the candidate, every competition of one weight (rule set, `need.fsp`).
	const fspCounts = need === null || need.fspRelevant;
	const record = fspCounts && !input.withoutFsp ? fspRecord(candidate.fspResults, params.fsp) : null;
	const fspValue = record?.value ?? 0;

	const lastAssigned = candidate.categories.reduce<Date | null>(
		(latest, c) => (latest === null || c.assignedAt > latest ? c.assignedAt : latest),
		null
	);
	const action = candidate.lastConfirmedAction;
	const lastConfirmed = action !== null && (lastAssigned === null || action > lastAssigned) ? action : lastAssigned;
	const days =
		lastConfirmed === null ? null : Math.max(0, Math.floor((now.getTime() - lastConfirmed.getTime()) / DAY_MS));
	const freshness = days === null ? 0 : Math.pow(0.5, days / params.freshness.halfLifeDays);

	const mean = (list: readonly SkillReading[]) => list.reduce((sum, s) => sum + s.value, 0) / list.length;
	const format = need?.workFormat ? readFormat(need, candidate.preferences, params.format) : null;
	const raw: Record<NeedComponentKey, Omit<NeedComponent, 'level' | 'weight' | 'contribution'>> = {
		required:
			required.length > 0
				? { applicable: true, status: 'computed', value: mean(required), reason: null }
				: { applicable: false, status: 'unknown', value: 0, reason: 'no_required_skills' },
		nice:
			nice.length > 0
				? { applicable: true, status: 'computed', value: mean(nice), reason: null }
				: { applicable: false, status: 'unknown', value: 0, reason: 'no_nice_skills' },
		format: format
			? { applicable: true, ...format }
			: { applicable: false, status: 'unknown', value: 0, reason: 'no_work_format' },
		test: { applicable: true, status: test.status, value: test.value, reason: test.reason },
		fsp: !fspCounts
			? { applicable: false, status: 'unknown', value: 0, reason: 'need_fsp_not_relevant' }
			: {
					applicable: true,
					status: 'computed',
					value: fspValue,
					reason: input.withoutFsp ? 'without_fsp' : record?.competitions === 0 ? 'no_fsp_results' : null
				},
		freshness: {
			applicable: true,
			status: 'computed',
			value: freshness,
			reason: days === null ? 'no_confirmed_action' : null
		}
	};
	// Without a need only the strength level counts.
	if (need === null) {
		for (const key of NEED_COMPONENT_KEYS) if (NEED_LEVEL[key] === 'need') raw[key].applicable = false;
	}
	const weights = params.weights;
	const denominator = NEED_COMPONENT_KEYS.reduce((sum, key) => sum + (raw[key].applicable ? weights[key] : 0), 0);
	if (denominator <= 0) throw new Error('the need asks for no component with a weight');
	const components = Object.fromEntries(
		NEED_COMPONENT_KEYS.map((key) => {
			const entry = raw[key];
			const weight = entry.applicable ? weights[key] : 0;
			return [
				key,
				{ ...entry, level: NEED_LEVEL[key], weight, contribution: (weight * entry.value) / denominator }
			] satisfies [NeedComponentKey, NeedComponent];
		})
	) as Record<NeedComponentKey, NeedComponent>;
	const score = NEED_COMPONENT_KEYS.reduce((sum, key) => sum + components[key].contribution, 0);
	const level = (name: 'need' | 'strength') =>
		round4(
			NEED_COMPONENT_KEYS.reduce((sum, key) => sum + (NEED_LEVEL[key] === name ? components[key].contribution : 0), 0)
		);

	// Reasons: skills grouped by basis, then the strength components, the strongest contributions first.
	const reasons: NeedReason[] = [];
	const skillShare = (reading: SkillReading) => {
		const component = components[reading.requirement];
		const count = reading.requirement === 'required' ? required.length : nice.length;
		return (component.weight * reading.value) / denominator / count;
	};
	const groups: [SkillBasis, SkillsReason['code']][] = [
		['test', 'skills_test'],
		['fsp', 'skills_fsp'],
		['platform', 'skills_platform'],
		['public_profile', 'skills_public_profile'],
		['claimed_untestable', 'skills_claimed_untestable'],
		['claimed', 'skills_claimed']
	];
	for (const [basis, code] of groups) {
		const group = [...required, ...nice].filter((s) => s.basis === basis);
		const first = group[0];
		if (!first) continue;
		const contribution = group.reduce((sum, s) => sum + skillShare(s), 0);
		let source: NeedReasonSource;
		if (basis === 'test') {
			const holder = candidate.categories.find((c) => c.confirmedSkillKeys.includes(first.skill_key));
			if (!holder || first.block === null) throw new Error('a skill confirmed by the test has no category');
			source = { kind: 'test_block', ref: first.block, specialization: holder.specialization, grade: holder.grade };
		} else if (basis === 'fsp') source = { kind: 'fsp_fact', fact_ids: group.flatMap((s) => s.fact_ids) };
		else if (basis === 'claimed' || basis === 'claimed_untestable') {
			source = { kind: 'declared_skill', ref: first.skill_key };
		} else source = { kind: 'evidence', fact_ids: group.flatMap((s) => s.fact_ids) };
		reasons.push({ code, skill_keys: group.map((s) => s.skill_key), contribution, source });
	}
	if (category !== null && test.status === 'computed' && test.margin !== null && test.strongestBlock !== null) {
		reasons.push({
			code: 'test_result',
			specialization: category.specialization,
			grade: category.grade,
			margin: round4(test.margin),
			contribution: components.test.contribution,
			source: {
				kind: 'test_block',
				ref: test.strongestBlock,
				specialization: category.specialization,
				grade: category.grade
			}
		});
	}
	if (components.fsp.applicable && record !== null && record.competitions > 0) {
		reasons.push({
			code: 'fsp_record',
			competitions: record.competitions,
			podiums: record.podiums,
			team_podiums: record.team_podiums,
			contribution: components.fsp.contribution,
			source: { kind: 'fsp_fact', fact_ids: record.fact_ids }
		});
	}
	if (need?.workFormat && components.format.status === 'computed' && components.format.value > 0) {
		reasons.push({
			code: 'format_fits',
			format: need.workFormat,
			contribution: components.format.contribution,
			source: { kind: 'preference', ref: 'work_formats' }
		});
	}
	// «Подтверждено N дн. назад» names the category: only when its assignment is the latest confirmed action.
	if (category !== null && days !== null && lastConfirmed === lastAssigned) {
		const block = category.confirmedBlocks[0];
		if (block !== undefined) {
			reasons.push({
				code: 'confirmed_recently',
				days,
				contribution: components.freshness.contribution,
				source: { kind: 'test_block', ref: block, specialization: category.specialization, grade: category.grade }
			});
		}
	}
	const shown = reasons
		.filter((reason) => reason.contribution > 0)
		.sort((a, b) => b.contribution - a.contribution)
		.slice(0, REASONS_MAX)
		.map((reason) => ({ ...reason, contribution: round4(reason.contribution) }));

	const compositeOf = need?.compositeSpecializations ?? [];
	const held = compositeOf.filter((s) => candidate.categories.some((c) => c.specialization === s));
	return {
		group,
		declared,
		fsp: record && { competitions: record.competitions, podiums: record.podiums, team_podiums: record.team_podiums },
		coverage: coverageOf(required),
		composite:
			compositeOf.length === 0
				? null
				: { specializations: [...compositeOf], held, complete: held.length === compositeOf.length },
		score: round4(score),
		levels: { need: level('need'), strength: level('strength') },
		components: Object.fromEntries(
			NEED_COMPONENT_KEYS.map((key) => [
				key,
				{ ...components[key], value: round4(components[key].value), contribution: round4(components[key].contribution) }
			])
		) as Record<NeedComponentKey, NeedComponent>,
		skills: [...required, ...nice],
		reasons: shown,
		gaps: required.filter((s) => s.basis === 'missing').map((s) => s.skill_key),
		toVerify: [...required, ...nice]
			.filter((s) => s.basis === 'claimed' || s.basis === 'claimed_untestable')
			.map((s) => s.skill_key),
		category
	};
}
