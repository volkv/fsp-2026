// Layer 3 of the evidence (docs/domain.md 9.3): contributions of facts and claims to skills and roles, groups of
// dependent evidence and the strength of a skill `1 − Π_g (1 − max_{i∈g} cᵢ)`. The FSP projection has already written
// the rule, weight, strength of the result and format and team factors into each claim (src/lib/server/fsp/projection.ts);
// here recency is applied at `as_of` and resume, platform test and public profile evidence is weighed by the rule set.
import { z } from 'zod';
import { MARKERS, TEAM_ROLES, type Marker, type StrengthBand, type TeamRole } from './params';
import type {
	Attestation,
	CategorizationSnapshot,
	ClaimInput,
	Contribution,
	FactInput,
	RulesContext,
	SkillInference,
	TrustLevel
} from './types';

const fspClaimValue = z.looseObject({
	target_kind: z.enum(['skill', 'role', 'marker']),
	target_key: z.string().min(1),
	rule_id: z.string().min(1),
	rule_version: z.string().min(1),
	weight: z.number().min(0).max(1),
	attestation: z.enum(['direct', 'derived']),
	group_key: z.string().min(1),
	strength_of_result: z.number().min(0).max(1),
	format_factor: z.number().min(0).max(1).optional(),
	team_factor: z.number().min(0).max(1).optional(),
	computed_indicator: z.string().nullable().optional()
});
type FspClaimValue = z.output<typeof fspClaimValue>;

const teamRoleValue = z.looseObject({ role: z.enum(TEAM_ROLES) });
const markerValue = z.looseObject({ marker: z.enum(MARKERS) });

/**
 * Payload of a `test_score` fact of the platform (domain 10.3): the assessment, the skills its version checks, the
 * strength its level scale gives the score and, for a level test, the grade the level corresponds to.
 */
const testScorePayload = z.looseObject({
	assessmentId: z.string().min(1),
	skillKeys: z.array(z.string().min(1)),
	levelStrength: z.number().min(0).max(1),
	gradeKey: z.string().min(1).nullable().optional()
});

/** Payload of a Codeforces fact of a verified profile (src/lib/server/external-profiles/facts.ts): what the rules read. */
const codeforcesPayload = z.looseObject({
	account: z.looseObject({ rating: z.int().nullable() }),
	maxRating: z.int().nullable(),
	solvedCount: z.int().min(0)
});

/** Payload of a GitHub fact of a verified profile: languages of the read own repositories by share of bytes. */
const githubPayload = z.looseObject({
	languages: z.array(z.looseObject({ name: z.string().min(1), share: z.number().min(0).max(1) }))
});

/** Strength of a Codeforces peak rating by the thresholds of the rule set (the last threshold not above it). */
function ratingStrength(rating: number, thresholds: readonly { fromRating: number; strength: number }[]): number {
	let strength = 0;
	for (const row of thresholds) if (rating >= row.fromRating) strength = row.strength;
	return strength;
}

/** Trust levels from the highest; the badge of a skill is the highest trust among its direct contributions. */
const TRUST_ORDER: readonly TrustLevel[] = ['fsp_verified', 'platform_verified', 'public_verifiable', 'claimed'];

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** Halves the weight every `halfLifeYears` from the day the fact happened to `as_of`; a future date counts as today. */
function recencyFactor(occurredOn: string | null, asOf: Date, halfLifeYears: number): number {
	if (occurredOn === null) return 1;
	const years = Math.max(0, (asOf.getTime() - Date.parse(`${occurredOn}T00:00:00Z`)) / YEAR_MS);
	return 0.5 ** (years / halfLifeYears);
}

/** The group of a non-FSP contribution: the event a claim was matched to, the fact's event, or the record itself. */
const groupOf = (fact: FactInput, claim: ClaimInput | null) => claim?.eventKey ?? fact.eventKey ?? fact.sourceRecordRef;

/** A direct rule over a fact whose ownership is not confirmed is only a claim (domain 9.1). */
const attestationOf = (rule: 'direct' | 'derived' | 'claimed', trust: TrustLevel): Attestation =>
	trust === 'claimed' ? 'claimed' : rule;

interface FspMarker {
	marker: Marker;
	fact_id: string;
	claim_id: string;
	weight: number;
}

interface ResumeMarker {
	marker: Marker;
	fact_id: string;
	claim_id: string;
	source: 'resume' | 'self_declared';
}

interface LevelTest {
	fact_id: string;
	gradeKey: string;
}

export interface CollectedEvidence {
	skills: Map<string, Contribution[]>;
	roles: Map<string, Contribution[]>;
	fspMarkers: FspMarker[];
	resumeMarkers: ResumeMarker[];
	levelTests: LevelTest[];
	unused: { fact_id: string; claim_id: string | null; code: string }[];
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

/** Contributions of every active fact, claim and experience entry of the snapshot, before parent propagation. */
export function collectEvidence(snapshot: CategorizationSnapshot, rules: RulesContext, asOf: Date): CollectedEvidence {
	const { params } = rules;
	const halfLife = params.evidence.recencyHalfLifeYears;
	const weights = params.evidence.claimWeights;
	const rulesetRef = `categorization_ruleset:${rules.rulesetVersion}`;
	const skillKeys = new Set(rules.skills.map((s) => s.key));
	const roleKeys = new Set(rules.roles.map((r) => r.key));
	const gradeKeys = new Set(rules.grades.map((g) => g.key));
	const facts = new Map(snapshot.facts.map((f) => [f.id, f]));
	const evidence: CollectedEvidence = {
		skills: new Map(),
		roles: new Map(),
		fspMarkers: [],
		resumeMarkers: [],
		levelTests: [],
		unused: []
	};
	const unused = (fact: FactInput, claim: ClaimInput | null, code: string) =>
		evidence.unused.push({ fact_id: fact.id, claim_id: claim?.id ?? null, code });

	const claimsByFact = new Map<string, ClaimInput[]>();
	for (const claim of snapshot.claims) {
		if (!facts.has(claim.factId)) {
			throw new Error(`claim ${claim.id} refers to fact ${claim.factId} outside the snapshot`);
		}
		push(claimsByFact, claim.factId, claim);
	}

	// Team role of each FSP result: a reserve or a trainer did not compete, so the result gives no skill or role.
	const teamRoles = new Map<string, TeamRole>();
	for (const claim of snapshot.claims) {
		if (claim.claimType === 'team_role' && claim.extractor === 'source_mapping') {
			teamRoles.set(claim.factId, teamRoleValue.parse(claim.value).role);
		}
	}

	for (const fact of [...snapshot.facts].sort((a, b) => (a.id < b.id ? -1 : 1))) {
		const factClaims = claimsByFact.get(fact.id) ?? [];
		const recency = recencyFactor(fact.occurredOn, asOf, halfLife);

		if (fact.source === 'fsp') {
			const teamRole = params.fspTeamRoles[teamRoles.get(fact.id) ?? 'unknown'];
			for (const claim of factClaims) {
				if (claim.claimType === 'team_role') {
					for (const [marker, weight] of Object.entries(teamRole.markers) as [Marker, number][]) {
						evidence.fspMarkers.push({ marker, fact_id: fact.id, claim_id: claim.id, weight });
					}
					continue;
				}
				if (claim.extractor !== 'source_mapping') {
					unused(fact, claim, 'not_a_projection_claim');
					continue;
				}
				const value: FspClaimValue = fspClaimValue.parse(claim.value);
				if (value.target_kind === 'marker') {
					if ((MARKERS as readonly string[]).includes(value.target_key)) {
						evidence.fspMarkers.push({
							marker: value.target_key as Marker,
							fact_id: fact.id,
							claim_id: claim.id,
							weight: value.weight
						});
					} else unused(fact, claim, 'unknown_marker');
					continue;
				}
				if (!teamRole.contributesSkills) {
					unused(fact, claim, 'team_role_without_contribution');
					continue;
				}
				const known = value.target_kind === 'skill' ? skillKeys : roleKeys;
				if (!known.has(value.target_key)) {
					unused(fact, claim, `${value.target_kind}_not_in_taxonomy`);
					continue;
				}
				const formatFactor = value.format_factor ?? null;
				const teamFactor = value.team_factor ?? null;
				const contribution =
					value.strength_of_result * value.weight * (formatFactor ?? 1) * (teamFactor ?? 1) * recency;
				push(value.target_kind === 'skill' ? evidence.skills : evidence.roles, value.target_key, {
					basis: 'fsp_projection',
					source: fact.source,
					fact_id: fact.id,
					claim_id: claim.id,
					experience_entry_id: null,
					group_key: value.group_key,
					rule_id: value.rule_id,
					rule_version: value.rule_version,
					weight: value.weight,
					strength_of_result: value.strength_of_result,
					format_factor: formatFactor,
					team_factor: teamFactor,
					recency_factor: round(recency, 6),
					computed_indicator: value.computed_indicator ?? null,
					via_skill: null,
					contribution,
					trust_level: fact.trustLevel,
					attestation: attestationOf(value.attestation, fact.trustLevel)
				});
			}
			continue;
		}

		if (fact.source === 'platform_test' && fact.factType === 'test_score') {
			const payload = testScorePayload.parse(fact.payload);
			const group = fact.eventKey ?? `test:assessment:${payload.assessmentId}`;
			for (const skill of [...new Set(payload.skillKeys)].sort()) {
				if (!skillKeys.has(skill)) {
					evidence.unused.push({ fact_id: fact.id, claim_id: null, code: 'skill_not_in_taxonomy' });
					continue;
				}
				push(evidence.skills, skill, {
					basis: 'platform_test',
					source: fact.source,
					fact_id: fact.id,
					claim_id: null,
					experience_entry_id: null,
					group_key: group,
					rule_id: `${rulesetRef}:platformTest`,
					rule_version: String(rules.rulesetVersion),
					weight: weights.platformTest,
					strength_of_result: payload.levelStrength,
					format_factor: null,
					team_factor: null,
					recency_factor: round(recency, 6),
					computed_indicator: null,
					via_skill: null,
					contribution: weights.platformTest * payload.levelStrength * recency,
					trust_level: fact.trustLevel,
					attestation: attestationOf('direct', fact.trustLevel)
				});
			}
			const gradeKey = payload.gradeKey ?? null;
			if (gradeKey !== null) {
				if (gradeKeys.has(gradeKey)) evidence.levelTests.push({ fact_id: fact.id, gradeKey });
				else evidence.unused.push({ fact_id: fact.id, claim_id: null, code: 'grade_not_in_taxonomy' });
			}
			continue;
		}

		if (fact.source === 'codeforces' || fact.source === 'github') {
			// A verified public profile (domain 9.4): the rule set says which skills its reading confirms and how strongly.
			const profileRules = params.evidence.publicProfiles;
			const group = fact.eventKey ?? fact.sourceRecordRef;
			const contribute = (
				skill: string,
				rule: string,
				weight: number,
				strength: number,
				attested: 'direct' | 'derived'
			) => {
				if (!skillKeys.has(skill)) {
					evidence.unused.push({ fact_id: fact.id, claim_id: null, code: 'skill_not_in_taxonomy' });
					return;
				}
				push(evidence.skills, skill, {
					basis: 'public_profile',
					source: fact.source,
					fact_id: fact.id,
					claim_id: null,
					experience_entry_id: null,
					group_key: group,
					rule_id: `${rulesetRef}:${rule}`,
					rule_version: String(rules.rulesetVersion),
					weight,
					strength_of_result: round(strength, 6),
					format_factor: null,
					team_factor: null,
					recency_factor: round(recency, 6),
					computed_indicator: null,
					via_skill: null,
					contribution: weight * strength * recency,
					trust_level: fact.trustLevel,
					attestation: attestationOf(attested, fact.trustLevel)
				});
			};
			if (fact.source === 'codeforces' && fact.factType === 'platform_rating') {
				const payload = codeforcesPayload.parse(fact.payload);
				const rule = profileRules.codeforces;
				const peak = payload.maxRating ?? payload.account.rating;
				if (payload.solvedCount < rule.minSolved) {
					unused(fact, null, 'too_few_solved');
				} else {
					// An unrated account with enough solved problems stands at the lowest threshold.
					const strength = ratingStrength(peak ?? 0, rule.ratingStrength);
					for (const skill of [...new Set(rule.skills)].sort()) {
						contribute(skill, 'publicProfiles.codeforces', rule.weight, strength, rule.attestation);
					}
				}
				continue;
			}
			if (fact.source === 'github' && fact.factType === 'repo_languages') {
				const payload = githubPayload.parse(fact.payload);
				const rule = profileRules.github;
				const bySkill = new Map<string, number>();
				for (const language of payload.languages) {
					const skill = rule.languages[language.name];
					if (skill === undefined || language.share < rule.minShare) continue;
					// Two linguist names of one skill (SCSS and Sass) add up.
					bySkill.set(skill, (bySkill.get(skill) ?? 0) + language.share);
				}
				if (bySkill.size === 0) unused(fact, null, 'no_language_above_share');
				for (const [skill, share] of [...bySkill].sort(([a], [b]) => (a < b ? -1 : 1))) {
					const strength = Math.min(1, share / rule.fullShare);
					contribute(skill, `publicProfiles.github.${skill}`, rule.weight, strength, rule.attestation);
				}
				continue;
			}
			unused(fact, null, 'no_rule');
			continue;
		}

		if (fact.source === 'resume' || fact.source === 'self_declared') {
			for (const claim of factClaims) {
				if (claim.polarity !== 'asserted') {
					// A negated or uncertain mention never gives a positive inference (domain 9.2).
					unused(fact, claim, `polarity_${claim.polarity}`);
					continue;
				}
				if (claim.claimType === 'responsibility_marker') {
					const parsed = markerValue.safeParse(claim.value);
					if (parsed.success) {
						evidence.resumeMarkers.push({
							marker: parsed.data.marker,
							fact_id: fact.id,
							claim_id: claim.id,
							source: fact.source
						});
					} else unused(fact, claim, 'unknown_marker');
					continue;
				}
				if (claim.claimType !== 'skill_mention' || fact.source !== 'resume') {
					unused(fact, claim, 'no_rule');
					continue;
				}
				if (claim.skillKey === null || !skillKeys.has(claim.skillKey)) {
					unused(fact, claim, 'skill_not_in_taxonomy');
					continue;
				}
				push(evidence.skills, claim.skillKey, {
					basis: 'resume_mention',
					source: fact.source,
					fact_id: fact.id,
					claim_id: claim.id,
					experience_entry_id: claim.experienceEntryId,
					group_key: groupOf(fact, claim),
					rule_id: `${rulesetRef}:resumeSkillMention`,
					rule_version: String(rules.rulesetVersion),
					weight: weights.resumeSkillMention,
					strength_of_result: null,
					format_factor: null,
					team_factor: null,
					recency_factor: 1,
					computed_indicator: null,
					via_skill: null,
					contribution: weights.resumeSkillMention,
					trust_level: fact.trustLevel,
					attestation: 'claimed'
				});
			}
			continue;
		}

		unused(fact, null, 'no_rule');
	}

	for (const entry of [...snapshot.experience].sort((a, b) => (a.id < b.id ? -1 : 1))) {
		const fact = facts.get(entry.factId);
		if (!fact) throw new Error(`experience entry ${entry.id} refers to fact ${entry.factId} outside the snapshot`);
		const base = {
			source: fact.source,
			fact_id: fact.id,
			claim_id: null,
			experience_entry_id: entry.id,
			group_key: groupOf(fact, null),
			rule_version: String(rules.rulesetVersion),
			strength_of_result: null,
			format_factor: null,
			team_factor: null,
			recency_factor: 1,
			computed_indicator: null,
			via_skill: null,
			trust_level: fact.trustLevel,
			attestation: 'claimed' as const
		};
		for (const skill of [...new Set(entry.appliedSkillKeys)].sort()) {
			if (!skillKeys.has(skill)) continue;
			push(evidence.skills, skill, {
				...base,
				basis: 'resume_experience',
				rule_id: `${rulesetRef}:resumeAppliedSkill`,
				weight: weights.resumeAppliedSkill,
				contribution: weights.resumeAppliedSkill
			});
		}
		if (entry.roleKey !== null && roleKeys.has(entry.roleKey)) {
			push(evidence.roles, entry.roleKey, {
				...base,
				basis: 'resume_experience',
				rule_id: `${rulesetRef}:resumeRoleExperience`,
				weight: weights.resumeRoleExperience,
				contribution: weights.resumeRoleExperience
			});
		}
	}
	return evidence;
}

/**
 * A confirmed child skill gives its ancestors a partial, always derived contribution (`childToParentFactor` per
 * level); a parent never passes anything down. The group stays the same, so a parent mentioned in the same resume
 * is not strengthened twice.
 */
export function propagateToParents(
	skills: Map<string, Contribution[]>,
	rules: RulesContext
): Map<string, Contribution[]> {
	const parents = new Map(rules.skills.map((s) => [s.key, s.parentKey]));
	const factor = rules.params.evidence.childToParentFactor;
	const result = new Map<string, Contribution[]>();
	for (const [skill, contributions] of skills) for (const c of contributions) push(result, skill, c);
	for (const [skill, contributions] of [...skills.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const seen = new Set([skill]);
		let parent = parents.get(skill) ?? null;
		let multiplier = factor;
		while (parent !== null && !seen.has(parent)) {
			seen.add(parent);
			for (const c of contributions) {
				push(result, parent, {
					...c,
					basis: 'child_skill',
					via_skill: skill,
					weight: multiplier,
					contribution: c.contribution * multiplier,
					attestation: 'derived'
				});
			}
			parent = parents.get(parent) ?? null;
			multiplier *= factor;
		}
	}
	return result;
}

/** Within a group the largest contribution counts, across groups they saturate: `1 − Π_g (1 − max_{i∈g} cᵢ)`. */
export function aggregateStrength(contributions: readonly Contribution[]): number {
	const groups = new Map<string, number>();
	for (const c of contributions) groups.set(c.group_key, Math.max(groups.get(c.group_key) ?? 0, c.contribution));
	let remaining = 1;
	for (const max of groups.values()) remaining *= 1 - Math.min(1, Math.max(0, max));
	return 1 - remaining;
}

function strengthBand(strength: number, rules: RulesContext): StrengthBand {
	const bands = rules.params.strengthBands;
	if (strength >= bands.strong) return 'strong';
	if (strength >= bands.moderate) return 'moderate';
	return 'weak';
}

const BAND_ORDER: readonly StrengthBand[] = ['weak', 'moderate', 'strong'];
export const bandAtLeast = (band: StrengthBand, min: StrengthBand) =>
	BAND_ORDER.indexOf(band) >= BAND_ORDER.indexOf(min);

/** Skill inferences with strength, band, attestation and badge (domain 9.3), ordered by skill key. */
export function buildInferences(skills: Map<string, Contribution[]>, rules: RulesContext): SkillInference[] {
	return [...skills.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([skillKey, contributions]) => {
			const strength = round(aggregateStrength(contributions), 3);
			const direct = contributions.filter((c) => c.attestation === 'direct');
			const attestation: Attestation =
				direct.length > 0 ? 'direct' : contributions.some((c) => c.attestation === 'derived') ? 'derived' : 'claimed';
			const badgeTrust =
				direct.length === 0 ? null : (TRUST_ORDER.find((trust) => direct.some((c) => c.trust_level === trust)) ?? null);
			const ordered = [...contributions].sort(
				(a, b) =>
					b.contribution - a.contribution ||
					(a.group_key < b.group_key ? -1 : a.group_key > b.group_key ? 1 : 0) ||
					(a.fact_id < b.fact_id ? -1 : a.fact_id > b.fact_id ? 1 : 0)
			);
			return {
				skillKey,
				strength,
				band: strengthBand(strength, rules),
				attestation,
				badgeTrust,
				contributions: ordered.map((c) => ({ ...c, contribution: round(c.contribution, 6) }))
			};
		});
}
