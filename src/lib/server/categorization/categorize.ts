// The categorization calculation (docs/domain.md 12.1–12.2): a pure, deterministic function of a profile snapshot, a
// taxonomy version, a rule set and `as_of`. Role, grade and stack core are independent axes, each set by its own
// grounds: an unknown axis never cancels a known one. The grade is set by production signals only — experience in the
// role, responsibility markers from the resume, a level test; FSP achievements go to skills and the FSP level facet.
import {
	aggregateStrength,
	bandAtLeast,
	buildInferences,
	collectEvidence,
	propagateToParents,
	type CollectedEvidence
} from './evidence';
import { experienceMonths, hasValidPeriod, summarizeExperience } from './experience';
import { fspLevels } from './fsp-level';
import type {
	AssignmentExplanation,
	AssignmentResult,
	CategorizationResult,
	CategorizationSnapshot,
	ClaimInput,
	Contribution,
	CoreGroupExplanation,
	DesiredRoleExplanation,
	ExperienceInput,
	GradeExplanation,
	GradeSignal,
	MissingByAxis,
	MissingItem,
	NextGradeRequirement,
	RoleExplanation,
	RoleRule,
	RulesContext,
	SkillInference,
	StackExplanation
} from './types';

const round = (value: number, digits: number) => Number(value.toFixed(digits));
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface RoleEvaluation {
	role: RoleRule;
	score: number;
	skillFit: number;
	roleEvidence: number;
	coreGroups: CoreGroupExplanation[];
	contributions: Contribution[];
	established: boolean;
	/** Established by grounds outside FSP alone. */
	establishedWithoutFsp: boolean;
}

interface Context {
	snapshot: CategorizationSnapshot;
	rules: RulesContext;
	asOf: Date;
	evidence: CollectedEvidence;
	inferences: Map<string, SkillInference>;
}

const strengthOf = (context: Context, skill: string) => context.inferences.get(skill)?.strength ?? 0;

/** Per group only the contribution that counts: the largest one (domain 9.3). */
function countedGrounds(contributions: readonly Contribution[]): Contribution[] {
	const best = new Map<string, Contribution>();
	for (const c of contributions) {
		const current = best.get(c.group_key);
		if (!current || c.contribution > current.contribution) best.set(c.group_key, c);
	}
	return [...best.values()].sort((a, b) => b.contribution - a.contribution || byKey(a.group_key, b.group_key));
}

// --- Role -----------------------------------------------------------------------------------------------------------

interface RoleGrounds {
	coreGroups: CoreGroupExplanation[];
	skillFit: number;
	roleEvidence: number;
	score: number;
}

/** Skill fit and role evidence of a role over the given skill strengths and role contributions. */
function roleGrounds(
	context: Context,
	role: RoleRule,
	strength: (skill: string) => number,
	contributions: readonly Contribution[]
): RoleGrounds {
	const { params } = context.rules;
	const coreGroups = role.coreSkillGroups.map((group): CoreGroupExplanation => {
		const best = [...group].sort((a, b) => strength(b) - strength(a) || byKey(a, b))[0];
		const value = best === undefined ? 0 : strength(best);
		const satisfied = best !== undefined && value > 0 && value >= params.role.coreSkillMinStrength;
		return { skills: group, satisfied_by: satisfied ? best : null, strength: round(value, 3) };
	});
	const coreScore =
		coreGroups.reduce((sum, g) => sum + (g.satisfied_by === null ? 0 : g.strength), 0) / Math.max(1, coreGroups.length);
	const typical = role.typicalSkills.map(strength).sort((a, b) => b - a);
	const typicalCount = Math.min(3, typical.length);
	const typicalScore =
		typicalCount === 0 ? 0 : typical.slice(0, typicalCount).reduce((a, b) => a + b, 0) / typicalCount;
	const typicalWeight = params.role.typicalSkillsWeight;
	const skillFit = (1 - typicalWeight) * coreScore + typicalWeight * typicalScore;
	const roleEvidence = aggregateStrength(contributions);
	// Skills that fit the role and direct evidence of the role are independent kinds of grounds: they saturate.
	const score = 1 - (1 - skillFit) * (1 - roleEvidence);
	return { coreGroups, skillFit: round(skillFit, 3), roleEvidence: round(roleEvidence, 3), score: round(score, 3) };
}

const outsideFsp = (contributions: readonly Contribution[]) => contributions.filter((c) => c.source !== 'fsp');

function evaluateRole(context: Context, role: RoleRule): RoleEvaluation {
	const { params } = context.rules;
	const contributions = context.evidence.roles.get(role.key) ?? [];
	const all = roleGrounds(context, role, (skill) => strengthOf(context, skill), contributions);
	// The same role over grounds outside FSP (rule set `coreSkillGrounds: outside_fsp`): an FSP result confirms a skill,
	// not the work of the role, so FSP skills alone never open the skill route.
	const own = roleGrounds(
		context,
		role,
		(skill) => round(aggregateStrength(outsideFsp(context.inferences.get(skill)?.contributions ?? [])), 3),
		outsideFsp(contributions)
	);
	const ownCoreSatisfied = own.coreGroups.every((g) => g.satisfied_by !== null);
	const { minScore } = params.role;
	return {
		role,
		score: all.score,
		skillFit: all.skillFit,
		roleEvidence: all.roleEvidence,
		coreGroups: all.coreGroups,
		contributions,
		// The skill route needs every core group confirmed outside FSP; evidence of the role itself (a position held, an
		// FSP specialization naming the role) may establish it with core skills unconfirmed — those are shown as «not
		// confirmed». FSP skills and role grounds add to the score either way: the sum of grounds ranks the roles.
		established: all.score >= minScore && (ownCoreSatisfied || all.roleEvidence >= minScore),
		establishedWithoutFsp: own.score >= minScore && (ownCoreSatisfied || own.roleEvidence >= minScore)
	};
}

function roleExplanation(evaluation: RoleEvaluation): RoleExplanation {
	return {
		role_key: evaluation.role.key,
		score: evaluation.score,
		skill_fit: evaluation.skillFit,
		role_evidence: evaluation.roleEvidence,
		established_without_fsp: evaluation.establishedWithoutFsp,
		core_groups: evaluation.coreGroups,
		unconfirmed_core_groups: evaluation.coreGroups.filter((g) => g.satisfied_by === null).map((g) => g.skills),
		contributions: countedGrounds(evaluation.contributions)
	};
}

// --- Stack core -------------------------------------------------------------------------------------------------------

function stackFor(context: Context, role: RoleRule | null): StackExplanation {
	const { params, skills } = context.rules;
	const kinds = new Map(skills.map((s) => [s.key, s.kind]));
	const parents = new Map(skills.map((s) => [s.key, s.parentKey]));
	const excluded = new Set(params.stack.excludeKinds);
	const eligible = [...context.inferences.values()].filter((i) => bandAtLeast(i.band, params.stack.minBand));

	let chosen: SkillInference[];
	if (role) {
		const core = new Set(role.coreSkillGroups.flat());
		const typical = new Set(role.typicalSkills);
		// 0 — core skill, 1 — typical skill, 2 — a framework or library under one of them, null — unrelated to the role.
		const tier = (skill: string): number | null => {
			if (core.has(skill)) return 0;
			if (typical.has(skill)) return 1;
			const seen = new Set([skill]);
			for (let p = parents.get(skill) ?? null; p !== null && !seen.has(p); p = parents.get(p) ?? null) {
				seen.add(p);
				if (core.has(p) || typical.has(p)) return 2;
			}
			return null;
		};
		chosen = eligible
			.filter((i) => tier(i.skillKey) !== null)
			.filter((i) => core.has(i.skillKey) || !excluded.has(kinds.get(i.skillKey) ?? 'domain'))
			.sort(
				(a, b) =>
					(tier(a.skillKey) ?? 3) - (tier(b.skillKey) ?? 3) || b.strength - a.strength || byKey(a.skillKey, b.skillKey)
			);
	} else {
		chosen = eligible
			.filter((i) => !excluded.has(kinds.get(i.skillKey) ?? 'domain'))
			.sort((a, b) => b.strength - a.strength || byKey(a.skillKey, b.skillKey));
	}
	const picked = chosen.slice(0, params.stack.maxSkills);
	const missing: MissingItem[] = [];
	if (picked.length === 0) {
		const below = [...context.inferences.values()]
			.filter((i) => !bandAtLeast(i.band, params.stack.minBand) && !excluded.has(kinds.get(i.skillKey) ?? 'domain'))
			.sort((a, b) => b.strength - a.strength || byKey(a.skillKey, b.skillKey))
			.slice(0, 3)
			.map((i) => ({ skill_key: i.skillKey, strength: i.strength, band: i.band }));
		missing.push({
			code: 'no_skill_in_band',
			min_band: params.stack.minBand,
			...(role ? { role_key: role.key } : {}),
			below_band: below
		});
	}
	return {
		status: picked.length > 0 ? 'established' : 'insufficient_data',
		skills: picked.map((i) => ({
			skill_key: i.skillKey,
			strength: i.strength,
			band: i.band,
			attestation: i.attestation,
			badge_trust: i.badgeTrust,
			grounds: countedGrounds(i.contributions)
		})),
		missing
	};
}

// --- Grade ------------------------------------------------------------------------------------------------------------

interface GradeOutcome {
	explanation: GradeExplanation;
	min: string | null;
	max: string | null;
	confidence: number | null;
}

function gradeFor(context: Context, role: RoleRule | null): GradeOutcome {
	const { snapshot, rules, evidence } = context;
	const { grade: params } = rules.params;
	const grades = [...rules.grades].sort((a, b) => a.ordinal - b.ordinal);
	const indexOf = (key: string) => {
		const index = grades.findIndex((g) => g.key === key);
		if (index < 0) throw new Error(`rule set refers to unknown grade ${key}`);
		return index;
	};
	const keyAt = (index: number) => {
		const grade = grades[index];
		if (!grade) throw new Error(`grade index ${index} out of range`);
		return grade.key;
	};

	const scope: GradeExplanation['scope'] = role === null ? 'all_experience' : params.experienceScope;
	const familyRoles = new Set(
		role === null ? [] : rules.roles.filter((r) => r.family === role.family).map((r) => r.key)
	);
	const inScope = (entry: ExperienceInput) =>
		role === null ||
		(scope === 'role' ? entry.roleKey === role.key : entry.roleKey !== null && familyRoles.has(entry.roleKey));
	const useExperience = params.signals.includes('role_experience');
	const counted = useExperience ? snapshot.experience.filter((e) => hasValidPeriod(e) && inScope(e)) : [];

	// Evidence that exists but by the rules never moves a grade (domain 12.2).
	const ignored: GradeExplanation['ignored'] = [];
	const fspFacts = snapshot.facts.filter((f) => f.source === 'fsp').map((f) => f.id);
	if (fspFacts.length > 0) ignored.push({ code: 'fsp_does_not_set_grade', fact_ids: fspFacts.sort() });
	if (evidence.fspMarkers.length > 0) {
		ignored.push({
			code: 'fsp_marker_not_a_grade_signal',
			fact_ids: [...new Set(evidence.fspMarkers.map((m) => m.fact_id))].sort()
		});
	}

	const periodGaps: MissingItem[] = snapshot.experience
		.filter((e) => !hasValidPeriod(e) && inScope(e))
		.sort((a, b) => byKey(a.id, b.id))
		.map((e) => ({
			code: e.periodStatus === 'missing' ? 'experience_period_missing' : 'experience_period_invalid',
			experience_entry_id: e.id
		}));

	const base = { scope, ignored };
	if (counted.length === 0) {
		const missing: MissingItem[] = [];
		if (!snapshot.experience.some(hasValidPeriod)) missing.push({ code: 'no_dated_experience' });
		else if (role !== null) missing.push({ code: 'no_role_experience', role_key: role.key, scope });
		missing.push(...periodGaps);
		return {
			explanation: {
				...base,
				status: 'insufficient_data',
				signals: [],
				disagreements: [],
				missing,
				next_grade: null
			},
			min: null,
			max: null,
			confidence: null
		};
	}

	const months = experienceMonths(counted, context.asOf);
	const bandFor = (value: number) => {
		const band = params.experienceBands.find(
			(b) => b.fromMonths <= value && (b.toMonths === null || value <= b.toMonths)
		);
		if (!band) throw new Error(`no experience band covers ${value} months`);
		return band;
	};
	const shortBand = bandFor(months.min_months);
	const longBand = bandFor(months.max_months);
	const low = indexOf(shortBand.min);
	let high = Math.max(low, indexOf(longBand.max));
	const signals: GradeSignal[] = [
		{
			signal: 'role_experience',
			...months,
			role_key: role?.key ?? null,
			experience_entry_ids: counted.map((e) => e.id).sort(),
			band: { from_months: shortBand.fromMonths, to_months: longBand.toMonths },
			grade_min: keyAt(low),
			grade_max: keyAt(high)
		}
	];

	const markerSources = new Set<string>(params.responsibilityMarkerSources);
	const markerKeys = new Set<string>(params.responsibilityMarkers.markers);
	const markers = params.signals.includes('responsibility_markers')
		? evidence.resumeMarkers.filter((m) => markerSources.has(m.source) && markerKeys.has(m.marker))
		: [];
	const requiredFor = new Set(params.responsibilityMarkers.requiredFor);
	if (markers.length > 0) {
		high = Math.min(grades.length - 1, high + params.responsibilityMarkers.raiseUpperBy);
		for (const m of markers) signals.push({ signal: 'responsibility_marker', marker: m.marker, claim_id: m.claim_id });
	} else {
		while (high > low && requiredFor.has(keyAt(high))) high--;
	}

	const disagreements: GradeExplanation['disagreements'] = [];
	let confidence = params.confidence.base;
	if (
		counted.every((e) => e.periodFromPrecision === 'month' && (e.periodTo === null || e.periodToPrecision === 'month'))
	) {
		confidence += params.confidence.monthPrecision;
	}
	if (counted.every((e) => e.candidateReview !== 'pending')) confidence += params.confidence.candidateConfirmed;

	const tests = params.signals.includes('level_test') ? evidence.levelTests : [];
	const bestTest = [...tests].sort(
		(a, b) => indexOf(b.gradeKey) - indexOf(a.gradeKey) || byKey(a.fact_id, b.fact_id)
	)[0];
	if (bestTest) {
		const tested = indexOf(bestTest.gradeKey);
		signals.push({ signal: 'level_test', fact_id: bestTest.fact_id, grade: bestTest.gradeKey });
		// A level test confirms the range or caps its upper end; it never raises it.
		if (tested >= low) {
			high = Math.min(high, Math.max(tested, low));
			confidence += params.confidence.levelTestConfirms;
		} else {
			disagreements.push(
				{ source: 'role_experience', grade_min: keyAt(low), grade_max: keyAt(high) },
				{ source: 'level_test', grade_min: bestTest.gradeKey, grade_max: bestTest.gradeKey, fact_id: bestTest.fact_id }
			);
			high = low;
			confidence -= params.confidence.levelTestDisagrees;
		}
	}

	return {
		explanation: {
			...base,
			status: 'established',
			signals,
			disagreements,
			missing: periodGaps,
			next_grade: nextGrade(context, role, {
				low,
				high,
				months: months.min_months,
				markers: markers.length > 0,
				grades
			})
		},
		min: keyAt(low),
		max: keyAt(high),
		confidence: round(Math.min(1, Math.max(0, confidence)), 2)
	};
}

/** What the next grade above the range requires by the rules: experience, a marker, a level test, role skills. */
function nextGrade(
	context: Context,
	role: RoleRule | null,
	state: { low: number; high: number; months: number; markers: boolean; grades: { key: string }[] }
): GradeExplanation['next_grade'] {
	const target = state.grades[state.high + 1];
	if (!target) return null;
	const { grade: params } = context.rules.params;
	const indexOf = (key: string) => state.grades.findIndex((g) => g.key === key);
	const targetIndex = state.high + 1;
	const raise = params.responsibilityMarkers.raiseUpperBy;
	const requirements: NextGradeRequirement[] = [];

	const reachable = (withMarker: boolean) =>
		params.experienceBands.find((b) => indexOf(b.max) + (withMarker ? raise : 0) >= targetIndex);
	let band = reachable(state.markers);
	let needsMarker = params.responsibilityMarkers.requiredFor.includes(target.key) && !state.markers;
	if (!band && !state.markers) {
		band = reachable(true);
		if (band) needsMarker = true;
	}
	if (band && band.fromMonths > state.months) {
		requirements.push({
			code: 'role_experience',
			role_key: role?.key ?? null,
			months_required: band.fromMonths,
			months_now: state.months
		});
	}
	if (needsMarker)
		requirements.push({ code: 'responsibility_marker', markers: [...params.responsibilityMarkers.markers] });
	const tested = context.evidence.levelTests.some((t) => indexOf(t.gradeKey) >= targetIndex);
	if (params.signals.includes('level_test') && !tested) requirements.push({ code: 'level_test', grade: target.key });
	if (role) {
		const { moderate } = context.rules.params.strengthBands;
		const coreGaps = role.coreSkillGroups.filter((group) =>
			group.every((skill) => strengthOf(context, skill) < context.rules.params.role.coreSkillMinStrength)
		);
		const typicalGaps = role.typicalSkills.filter((skill) => strengthOf(context, skill) < moderate).sort(byKey);
		if (coreGaps.length > 0 || typicalGaps.length > 0) {
			requirements.push({
				code: 'role_skills',
				role_key: role.key,
				taxonomy_version: context.rules.taxonomyLabel,
				core_groups: coreGaps,
				typical_skills: typicalGaps
			});
		}
	}
	return { target: target.key, requirements };
}

// --- Assembly ---------------------------------------------------------------------------------------------------------

function desiredRoles(context: Context, evaluations: Map<string, RoleEvaluation>, assigned: string[]) {
	return context.snapshot.desiredRoleKeys.map((key): DesiredRoleExplanation => {
		const evaluation = evaluations.get(key);
		if (!evaluation) {
			return { role_key: key, status: 'unknown_role', score: null, unconfirmed_core_groups: [], role_evidence: null };
		}
		const position = assigned.indexOf(key);
		return {
			role_key: key,
			status: position === 0 ? 'primary' : position > 0 ? 'secondary' : 'not_inferred',
			score: evaluation.score,
			unconfirmed_core_groups: evaluation.coreGroups.filter((g) => g.satisfied_by === null).map((g) => g.skills),
			role_evidence: evaluation.roleEvidence
		};
	});
}

function roleMissing(evaluations: RoleEvaluation[], minScore: number): MissingItem[] {
	const near = evaluations.filter((e) => e.score > 0).slice(0, 3);
	if (near.length === 0) return [{ code: 'no_role_evidence' }];
	return near.map((e) => ({
		code: 'role_below_threshold',
		role_key: e.role.key,
		score: e.score,
		min_score: minScore,
		unconfirmed_core_groups: e.coreGroups.filter((g) => g.satisfied_by === null).map((g) => g.skills)
	}));
}

/**
 * Categorizes one profile snapshot. Deterministic: the same snapshot, taxonomy version, rule set and `as_of` give the
 * same result; it calls no model and reads no clock.
 */
export function categorize(snapshot: CategorizationSnapshot, rules: RulesContext, asOf: Date): CategorizationResult {
	const { params } = rules;
	const evidence = collectEvidence(snapshot, rules, asOf);
	const inferenceList = buildInferences(propagateToParents(evidence.skills, rules), rules);
	const context: Context = {
		snapshot,
		rules,
		asOf,
		evidence,
		inferences: new Map(inferenceList.map((i) => [i.skillKey, i]))
	};

	const evaluationList = rules.roles
		.map((role) => evaluateRole(context, role))
		.sort((a, b) => b.score - a.score || byKey(a.role.key, b.role.key));
	const evaluations = new Map(evaluationList.map((e) => [e.role.key, e]));
	const established = evaluationList.filter((e) => e.established);
	// Rule set `primaryRole: grounds_outside_fsp_first`: FSP supports a role and never outranks a role the resume, the
	// experience or a platform test establish without it.
	const primaryRole = established.find((e) => e.establishedWithoutFsp) ?? established[0] ?? null;
	const roleAssignments = primaryRole
		? [
				primaryRole,
				...established
					.filter((e) => e !== primaryRole)
					.filter((e) => e.score >= params.role.secondaryMinScoreRatio * primaryRole.score)
					.slice(0, params.role.maxSecondary)
			]
		: [];
	const assignedKeys = roleAssignments.map((e) => e.role.key);
	const desired = desiredRoles(context, evaluations, assignedKeys);
	const fspMarkers = [...evidence.fspMarkers].sort((a, b) => byKey(a.fact_id, b.fact_id) || byKey(a.marker, b.marker));

	const explanationBase = (rank: 'primary' | 'secondary') => ({
		ruleset_version: rules.rulesetVersion,
		taxonomy_version: rules.taxonomyLabel,
		desired_roles: rank === 'primary' ? desired : [],
		fsp_markers: fspMarkers
	});

	const assignments: AssignmentResult[] = roleAssignments.map((evaluation, index) => {
		const rank = index === 0 ? 'primary' : 'secondary';
		const stack = stackFor(context, evaluation.role);
		const grade = gradeFor(context, evaluation.role);
		const explanation: AssignmentExplanation = {
			...explanationBase(rank),
			role: roleExplanation(evaluation),
			grade: grade.explanation,
			stack
		};
		return {
			rank,
			roleStatus: 'established',
			roleKey: evaluation.role.key,
			score: evaluation.score,
			gradeStatus: grade.explanation.status,
			gradeMin: grade.min,
			gradeMax: grade.max,
			gradeConfidence: grade.confidence,
			stackStatus: stack.status,
			stackSkillKeys: stack.skills.map((s) => s.skill_key),
			explanation
		};
	});

	// Without an inferred role the desired roles and what they lack are part of what is missing on the role axis.
	const missingRole = primaryRole
		? []
		: [
				...roleMissing(evaluationList, params.role.minScore),
				...desired.map((d) => ({
					code: 'desired_role_not_inferred',
					role_key: d.role_key,
					known_role: d.status !== 'unknown_role',
					score: d.score,
					unconfirmed_core_groups: d.unconfirmed_core_groups
				}))
			];
	let missing: MissingByAxis;
	if (primaryRole) {
		const primary = assignments[0];
		if (!primary) throw new Error('primary assignment missing');
		missing = {
			role: [],
			grade: primary.gradeStatus === 'established' ? [] : primary.explanation.grade.missing,
			stack: primary.stackStatus === 'established' ? [] : primary.explanation.stack.missing
		};
	} else {
		// No role: the stack and the grade may still be known and keep the candidate findable by them.
		const stack = stackFor(context, null);
		const grade = gradeFor(context, null);
		missing = {
			role: missingRole,
			grade: grade.explanation.status === 'established' ? [] : grade.explanation.missing,
			stack: stack.status === 'established' ? [] : stack.missing
		};
		if (stack.status === 'established' || grade.explanation.status === 'established') {
			assignments.push({
				rank: 'primary',
				roleStatus: 'insufficient_data',
				roleKey: null,
				score: null,
				gradeStatus: grade.explanation.status,
				gradeMin: grade.min,
				gradeMax: grade.max,
				gradeConfidence: grade.confidence,
				stackStatus: stack.status,
				stackSkillKeys: stack.skills.map((s) => s.skill_key),
				explanation: {
					...explanationBase('primary'),
					role: { status: 'insufficient_data', missing: missingRole },
					grade: grade.explanation,
					stack
				}
			});
		}
	}

	const primary = assignments[0];
	const outcome: CategorizationResult['outcome'] = !primary
		? 'insufficient_data'
		: primary.roleStatus === 'established' &&
			  primary.gradeStatus === 'established' &&
			  primary.stackStatus === 'established'
			? 'complete'
			: 'partial';

	const claimsByFact = new Map<string, ClaimInput[]>();
	for (const claim of snapshot.claims)
		claimsByFact.set(claim.factId, [...(claimsByFact.get(claim.factId) ?? []), claim]);

	return {
		outcome,
		assignments,
		missing,
		experienceSummary: summarizeExperience(snapshot.experience, asOf),
		inferences: inferenceList,
		fspLevels: fspLevels(snapshot.facts, claimsByFact, rules),
		unused: [...evidence.unused].sort(
			(a, b) => byKey(a.fact_id, b.fact_id) || byKey(a.claim_id ?? '', b.claim_id ?? '') || byKey(a.code, b.code)
		)
	};
}
