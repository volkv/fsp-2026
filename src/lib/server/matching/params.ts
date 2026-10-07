// Parameters of a match rule set (docs/domain.md, sections 11 and 13.4): component weights, band values, role, trust,
// salary and grade rules, the pool threshold. Imported by plain Node through the taxonomy release: relative imports only,
// erasable syntax only.
import { z } from 'zod';
import { SPECIALIZATION_KEYS } from '../assessments/contract/catalog.ts';
import { DISCIPLINE_CODES } from '../fsp/types.ts';

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
	 * components of the evidence itself when the candidate has no usable evidence run (`unavailableEvidenceValue`). The
	 * role component is 1 when a category in force is of the vacancy's specialization and 0 when only of another one
	 * (domain 13.4); without a category it is unknown.
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
	 * Trust in the score: the share of the required skills covered by directly confirmed inferences (by their band),
	 * scaled by the agreement of the confirmed grade of the candidate's category with the vacancy's range. `gradeWeight` is
	 * how much of the trust rests on that agreement (below 1, so that a confirmed skill always keeps some trust);
	 * `unknownGradeAgreement` stands for the agreement of a candidate without a category of the vacancy's specialization.
	 */
	trust: z.strictObject({ gradeWeight: z.number().min(0).lt(1), unknownGradeAgreement: unit }),
	/**
	 * Value that the required, nice-to-have and trust components count with while the candidate has no usable evidence
	 * run (none published, or evidence withdrawn after it). They stay `unavailable` without a value, but their weight
	 * stays in the score: a candidate whose evidence was read always has them computed, so dropping them would let a
	 * profile with nothing read outrank one whose skills were checked. 0 scores such a candidate as one without
	 * confirmed skills; role and grade come from the category, which does not depend on the evidence run.
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
	poolThreshold: unit,
	/** Ranking of a shortlist for a hiring need and of the catalog without one (domain 13.10). */
	need: z.strictObject({
		/**
		 * Weights of the two levels. Fit to the need: `required`, `nice` — coverage of the need's skills; `format` — the
		 * work format and region of the need against the candidate's preferences. Strength of the confirmed profile:
		 * `test` — the result of the test by blocks; `fsp` — the FSP record of the candidate (`fsp` below); `freshness`
		 * — how recent the last confirmed action is. A component the need does not ask for (no nice skills, no format,
		 * FSP marked as irrelevant) is out of the score of every candidate of the need, so the denominator is one for
		 * all of them and each contribution is exact. The catalog without a need ranks by the strength weights alone.
		 */
		weights: z
			.strictObject({
				required: z.number().nonnegative(),
				nice: z.number().nonnegative(),
				format: z.number().nonnegative(),
				test: z.number().nonnegative(),
				fsp: z.number().nonnegative(),
				freshness: z.number().nonnegative()
			})
			.refine((w) => w.test + w.fsp + w.freshness > 0, 'the strength level has a positive weight')
			// FSP lifts a candidate inside a category and never outweighs the test or the fit to the required skills.
			.refine((w) => w.fsp < w.test && w.fsp < w.required, 'FSP weighs less than the test and the required skills'),
		/**
		 * Value of a skill of the need by its best basis: a skill of the confirmed stack of a category in force (the test)
		 * is worth `test`; a direct FSP or platform confirmation — the band value; a verified public profile — the band
		 * value times `publicProfileFactor`; a claim or a derivation from the resume — the band value, but never more than
		 * `claimedCeiling`, so what the candidate says of themselves cannot outweigh a check. A skill no block of the
		 * need's specializations can confirm (ClickHouse, Kafka) has no check to outweigh: its claim is capped by
		 * `untestableClaimedCeiling`, still below a verified public profile.
		 */
		skill: z.strictObject({
			test: positiveUnit,
			publicProfileFactor: unit,
			claimedCeiling: unit,
			untestableClaimedCeiling: unit
		}),
		/**
		 * The test by blocks: the margin of a block is `(S − C) / (20 · items)`, shrunk toward zero as `items / (items +
		 * shrinkItems)` so that a lucky short block counts less; blocks whose skills the need asks for weigh
		 * `needBlockFactor` times more; the value is `0.5 + marginScale · mean margin`, clamped to [0, 1] — 0.5 is a
		 * result exactly at the cut. Without a readable result the value is `unknownValue`.
		 */
		test: z.strictObject({
			shrinkItems: z.number().nonnegative(),
			needBlockFactor: z.number().min(1),
			marginScale: z.number().positive(),
			unknownValue: unit
		}),
		/**
		 * The FSP record: official results of FSP competitions in force, whatever their level. Every discipline is of one
		 * priority; what tells them apart is only the relevance of a competition's discipline to the specialization the
		 * candidate is ranked in (`disciplines`): a competition of a relevant discipline weighs 1, of any other —
		 * `otherDisciplineWeight`, never 0 (it is still a confirmed result). `N` — the weights of the distinct
		 * competitions, `M` — of those with a win or a prize, individual or of the team (a team's win is a result of the
		 * team, not a confirmation of a skill or of a personal share). The value is
		 * `participationShare · (1 − 2^(−N / competitionsHalf)) + (1 − participationShare) · (1 − 2^(−M / podiumsHalf))`:
		 * each part saturates — half of it at `competitionsHalf` weight of competitions or `podiumsHalf` of podiums — so the
		 * record lifts a candidate and never runs away. One podium, even of another discipline, is worth more than any
		 * number of participations of equal relevance; without FSP the value is 0, the absence of the bonus, never a
		 * penalty.
		 */
		fsp: z
			.strictObject({
				participationShare: z.number().gt(0).lt(1),
				competitionsHalf: z.number().positive(),
				podiumsHalf: z.number().positive(),
				otherDisciplineWeight: z.number().gt(0).lt(1),
				/**
				 * The specializations of the catalog each discipline is relevant to, with the basis of the row. Every
				 * discipline of the adapter is listed once; a discipline relevant to none has an empty list.
				 */
				disciplines: z
					.array(
						z.strictObject({
							discipline: z.enum(DISCIPLINE_CODES),
							specializations: z
								.array(z.enum(SPECIALIZATION_KEYS))
								.refine((keys) => new Set(keys).size === keys.length, 'a specialization is listed once'),
							basis: z.string().min(1)
						})
					)
					.refine(
						(rows) =>
							rows.length === DISCIPLINE_CODES.length &&
							DISCIPLINE_CODES.every((code) => rows.some((row) => row.discipline === code)),
						'every discipline is listed once'
					)
			})
			.refine(
				(f) =>
					(1 - f.participationShare) * (1 - Math.pow(2, -f.otherDisciplineWeight / f.podiumsHalf)) >
					f.participationShare,
				'one podium of another discipline is worth more than any number of participations'
			),
		/** Freshness halves every `halfLifeDays` days since the last confirmed action. */
		freshness: z.strictObject({ halfLifeDays: z.number().positive() }),
		/**
		 * The work format: 1 when the candidate accepts the need's format (and, for an office or hybrid need with a
		 * region, lives there); `relocation` when only ready to relocate; 0 otherwise; `unknownValue` when the candidate
		 * stated no formats — an unknown is not a mismatch.
		 */
		format: z.strictObject({ relocation: unit, unknownValue: unit }),
		/** Scores closer than this are almost equal: their order is decided by the semantic similarity to the need. */
		nearTie: z.number().min(0).max(0.1)
	})
});

export type MatchRulesetParams = z.infer<typeof matchRulesetParamsSchema>;
