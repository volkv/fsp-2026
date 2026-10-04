// Parameters of a match rule set (docs/domain.md, sections 11 and 13.4): component weights, band values, role, trust,
// salary and grade rules, the pool threshold. Imported by plain Node through the taxonomy release: relative imports only,
// erasable syntax only.
import { z } from 'zod';

const unit = z.number().min(0).max(1);
const positiveUnit = z.number().gt(0).max(1);

/** Order of the stored decomposition: a component added later goes last, so stored rows keep their letters. */
export const COMPONENT_KEYS = ['required', 'nice', 'trust', 'grade', 'salary', 'semantic', 'reranker', 'role'] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

export type ComponentStatus = 'computed' | 'unknown' | 'unavailable' | 'not_comparable';

/**
 * A stored decomposition (`match_scores.component_statuses`) keeps one letter per component in the order of
 * `COMPONENT_KEYS`; the values are an array in the same order.
 */
export const COMPONENT_STATUS_CODES = {
	computed: 'c',
	unknown: 'u',
	unavailable: 'a',
	not_comparable: 'n'
} as const satisfies Record<ComponentStatus, string>;

export const matchRulesetParamsSchema = z.strictObject({
	/**
	 * Weight of each component. A component that is not computed drops out and the rest are renormalized, except the
	 * components of the evidence itself when the candidate has no usable categorization run (`unavailableEvidenceValue`).
	 */
	weights: z
		.strictObject({
			required: z.number().nonnegative(),
			nice: z.number().nonnegative(),
			trust: z.number().nonnegative(),
			grade: z.number().nonnegative(),
			salary: z.number().nonnegative(),
			semantic: z.number().nonnegative(),
			reranker: z.number().nonnegative(),
			role: z.number().nonnegative()
		})
		.refine((weights) => Object.values(weights).some((weight) => weight > 0), 'at least one weight is positive'),
	/**
	 * Coverage of a requirement by a skill inference of the band; the band, not the raw strength, is what people see. An
	 * inference always covers something: a zero would let a directly confirmed skill count for nothing in the trust.
	 */
	skillBandValue: z.strictObject({ weak: positiveUnit, moderate: positiveUnit, strong: positiveUnit }),
	/**
	 * The role of the vacancy against the candidate's: the primary category's role is 1, a secondary category's role and
	 * a desired role that the evidence does not establish are worth these values, any other established role is 0.
	 */
	role: z.strictObject({ secondary: unit, desired: unit }),
	/**
	 * Trust in the score: the share of the required skills covered by directly confirmed inferences (by their band),
	 * scaled by the agreement of the candidate's grade range with the vacancy's. `gradeWeight` is how much of the trust
	 * rests on that agreement (below 1, so that a confirmed skill always keeps some trust); `unknownGradeAgreement` stands
	 * for the agreement of a candidate whose grade is not established.
	 */
	trust: z.strictObject({ gradeWeight: z.number().min(0).lt(1), unknownGradeAgreement: unit }),
	/**
	 * Value that the required, nice-to-have and trust components count with while the candidate has no usable
	 * categorization run (none published, or evidence withdrawn after it). They stay `unavailable` without a value, but
	 * their weight stays in the score: a candidate whose evidence was read always has them computed, so dropping them
	 * would let a profile with nothing read outrank one whose skills were checked. 0 scores such a candidate as one
	 * without confirmed skills; role and grade drop out as they do for a read candidate without an established one.
	 */
	unavailableEvidenceValue: unit,
	/** Grade ranges that do not intersect lose this much per grade step between them. */
	grade: z.strictObject({ stepPenalty: z.number().gt(0).max(1) }),
	/** Value of `compareSalary(candidate expectation, vacancy range)`; `not_comparable` is a status, never a value. */
	salary: z.strictObject({ lower: unit, equal: unit, overlap: unit, higher: unit }),
	/** Cosine similarity below `minCosine` counts as 0; above it is stretched linearly to 1. */
	semantic: z.strictObject({ minCosine: z.number().min(0).lt(1) }),
	/** How the reranker reports relevance: a probability in [0, 1] or an unbounded logit. */
	reranker: z.strictObject({ scale: z.enum(['probability', 'logit']) }),
	/** «In the pool N confirmed candidates» counts pairs at or above this score (domain 13.3). */
	poolThreshold: unit
});

export type MatchRulesetParams = z.infer<typeof matchRulesetParamsSchema>;
