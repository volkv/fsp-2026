// `matchScore(vacancy, candidate, ruleset)` (docs/domain.md, section 13.4): a pure function over snapshots, the same
// in both directions. Each component carries a status; computed components enter the weighted score, unknowns are
// explained instead of being penalized. The one exception is a candidate without a usable evidence run: the
// components of the evidence itself (`scoredWithoutValue`) keep their weight at the rule set's
// `unavailableEvidenceValue` instead of dropping out. At 0, as shipped, such a profile scores on them as one whose
// evidence was read and covers none of the vacancy's skills; the other components still count, so it can outrank a
// read profile that loses on role, grade or salary.
import { scoredWithoutValue, type EvidenceUnavailableReason } from '$lib/matching/evidence-components';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { specializationsOfRole } from '$lib/server/categories/roles';
import { compareSalary, type SalaryComparison, type SalaryTerms } from '$lib/server/salary/compare';
import type { ComponentKey, ComponentStatus, MatchRulesetParams } from './params';

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
