// Parameters of a categorization rule set (docs/domain.md 9.3, 11, 12): how contributions are weighted, grouped and
// banded, how a role, a stack core and a grade range are established. Version 3 adds the weights of evidence that is not
// projected from FSP (resume, platform test), the role threshold, the kinds kept out of a stack core and the grade
// confidence. Version 5 makes FSP a supporting ground of a role: a result confirms skills, not the work of a role.
// Version 6 weighs verified public profiles (Codeforces, GitHub): which skills a reading confirms and how strongly.
// Imported by plain Node through the taxonomy release: relative imports only, erasable syntax only.
import { z } from 'zod';

export const STRENGTH_BANDS = ['weak', 'moderate', 'strong'] as const;
export type StrengthBand = (typeof STRENGTH_BANDS)[number];

export const MARKERS = ['mentoring', 'team_lead', 'architecture'] as const;
export type Marker = (typeof MARKERS)[number];

export const TEAM_ROLES = ['athlete', 'captain', 'reserve', 'trainer', 'unknown'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const SKILL_KINDS = [
	'language',
	'framework',
	'library',
	'runtime',
	'platform',
	'database',
	'tool',
	'practice',
	'domain'
] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

const key = z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be a snake_case key');
/** camelCase name of an evidence group. */
const fieldName = z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'must be a camelCase field name');
const text = z.string().regex(/\S/, 'must not be blank');

/** A number written with at most `scale` decimals: parameters are stated, not computed. */
function decimal(scale: number) {
	return z
		.number()
		.refine((value) => Number(value.toFixed(scale)) === value, { message: `must have at most ${scale} decimals` });
}
const weight = decimal(3).min(0).max(1);

const attestation = z.enum(['direct', 'derived']);

/**
 * Contributions of a verified public profile (domain 9.4). Codeforces: the peak rating of rated contests, by thresholds,
 * confirms the skills of competitive programming; an account with too few solved problems confirms nothing. GitHub: a
 * language holding at least `minShare` of the bytes of the read own repositories confirms its skill, full strength
 * from `fullShare` on; a repository language is weaker evidence than a platform test.
 */
const publicProfilesSchema = z.strictObject({
	codeforces: z.strictObject({
		skills: z.array(key).min(1),
		weight,
		attestation,
		minSolved: z.int().min(0),
		ratingStrength: z
			.array(z.strictObject({ fromRating: z.int().min(0), strength: weight }))
			.min(1)
			.refine((rows) => rows[0]?.fromRating === 0, { message: 'the first threshold starts at rating 0' })
			.refine((rows) => rows.every((row, i) => i === 0 || row.fromRating > (rows[i - 1]?.fromRating ?? 0)), {
				message: 'thresholds must ascend'
			})
			.refine((rows) => rows.every((row, i) => i === 0 || row.strength >= (rows[i - 1]?.strength ?? 0)), {
				message: 'a higher rating never gives a lower strength'
			})
	}),
	github: z
		.strictObject({
			weight,
			attestation,
			minShare: weight,
			fullShare: weight,
			/** GitHub language name (as `linguist` names it) → skill key. */
			languages: z.record(z.string().min(1), key)
		})
		.refine((g) => g.minShare > 0 && g.minShare <= g.fullShare, { message: 'minShare must be in (0, fullShare]' })
});

export const categorizationParamsSchema = z.strictObject({
	evidence: z
		.strictObject({
			// Weight of a fact is its relevance to the particular claim, not a global ranking of sources (domain 9.3).
			weighting: z.literal('relevance_to_claim'),
			aggregation: z.strictObject({ withinGroup: z.literal('max'), acrossGroups: z.literal('noisy_or') }),
			groupKeys: z.record(fieldName, text),
			childToParentFactor: weight,
			recencyHalfLifeYears: decimal(2).positive(),
			// Evidence the FSP projection rules do not weigh. A resume is one self-declaration: its mentions share a group.
			claimWeights: z.strictObject({
				resumeSkillMention: weight,
				resumeAppliedSkill: weight,
				resumeRoleExperience: weight,
				platformTest: weight
			}),
			publicProfiles: publicProfilesSchema
		})
		// A repository language is weaker evidence of a skill than the platform's own test of it.
		.refine((e) => e.publicProfiles.github.weight < e.claimWeights.platformTest, {
			message: 'a GitHub language must weigh less than a platform test',
			path: ['publicProfiles', 'github', 'weight']
		}),
	strengthBands: z
		.strictObject({ moderate: weight, strong: weight })
		.refine((b) => b.moderate > 0 && b.moderate < b.strong, { message: 'bands must be ordered' }),
	fspTeamRoles: z.record(
		z.enum(TEAM_ROLES),
		z.strictObject({ contributesSkills: z.boolean(), markers: z.partialRecord(z.enum(MARKERS), weight) })
	),
	role: z.strictObject({
		coreSkillMinStrength: weight,
		typicalSkillsWeight: weight,
		secondaryMinScoreRatio: weight,
		maxSecondary: z.int().min(0),
		/** A role is established from this score on. */
		minScore: weight,
		/**
		 * The skill route to a role counts a core skill group only with grounds outside FSP: a result confirms the skill,
		 * not the work of the role. FSP reaches a role only by its own role ground, a specialization naming the role.
		 */
		coreSkillGrounds: z.literal('outside_fsp'),
		/**
		 * A role FSP alone establishes is never primary over a role established without FSP; among either kind the sum
		 * of grounds decides.
		 */
		primaryRole: z.literal('grounds_outside_fsp_first')
	}),
	stack: z.strictObject({
		maxSkills: z.int().min(1),
		minBand: z.enum(STRENGTH_BANDS),
		/** Kinds that enter a stack core only as a core skill of the role (processes and soft skills). */
		excludeKinds: z.array(z.enum(SKILL_KINDS))
	}),
	grade: z.strictObject({
		signals: z.array(z.enum(['role_experience', 'responsibility_markers', 'level_test'])).min(1),
		// FSP achievements and team roles neither set nor shift a grade (domain 12.2).
		responsibilityMarkerSources: z.array(z.enum(['resume'])).min(1),
		fspAffectsGrade: z.literal(false),
		/** Which experience counts for a role: its own entries or the entries of its role family (domain 9.5). */
		experienceScope: z.enum(['role', 'role_family']),
		experienceBands: z
			.array(z.strictObject({ fromMonths: z.int().min(0), toMonths: z.int().min(0).nullable(), min: key, max: key }))
			.min(1),
		responsibilityMarkers: z.strictObject({
			markers: z.array(z.enum(MARKERS)).min(1),
			raiseUpperBy: z.int().min(0),
			requiredFor: z.array(key)
		}),
		levelTest: z.literal('confirms_or_caps_upper'),
		disagreement: z.literal('show_each_source'),
		confidence: z.strictObject({
			base: weight,
			/** Every counted period is known to the month. */
			monthPrecision: weight,
			/** Every counted entry is confirmed or edited by the candidate. */
			candidateConfirmed: weight,
			levelTestConfirms: weight,
			levelTestDisagrees: weight
		})
	}),
	desiredRoleAffectsResult: z.literal(false)
});

export type CategorizationParams = z.output<typeof categorizationParamsSchema>;
