// «Что ищет рынок в твоей категории» (CONCEPT, promises 3 and 5; docs/domain.md 13.9): how often the vacancies of the
// candidate's role — and of their grade with the next one — require each skill, and which of the most required skills
// the candidate has not confirmed yet, with the way to confirm each: a platform test or an FSP result. The share is
// the market's demand, not a promise: confirming a skill neither guarantees an invitation nor raises the grade.
//
// The counting of required skills over a set of vacancies is shared with the operator's feedback «market ↔ FSP»
// (`operator/skills-feedback.ts`); the sets differ. The candidate counts the vacancies open right now and within their
// reach — what the feed «Вакансии для тебя» ranks, a clone of a demo session seeing its session (domain 19.3); the
// operator counts every vacancy seen in the window outside demo sessions.
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { publishedVersions } from '$lib/server/assessments/versions';
import type { Executor } from '$lib/server/db';
import { categorizationRuns, fspProjectionRules, vacancies } from '$lib/server/db/schema';
import { demoSessionOfUser } from '$lib/server/demo/scope';
import { ApiError } from '$lib/server/errors/api-error';
import { loadMarketPolicy } from '$lib/server/market/policy';
import { loadCandidateSnapshots, loadGradeOrdinals, matchableVacancyFor } from '$lib/server/matching/evidence';
import { latestPublishedVersion } from '$lib/server/taxonomy/vocabulary';

/** When a vacancy entered the aggregator: published on the platform, or first seen by an import. */
export const vacancySeenAt = sql`coalesce(${vacancies.publishedAt}, ${vacancies.createdAt})`;

export interface VacancySkillDemand {
	vacancies: number;
	own: number;
	external: number;
	/** Some of the counted vacancies are seeded demo records. */
	seeded: boolean;
	/** The latest `vacancySeenAt` among the counted vacancies. */
	latestSeenAt: Date | null;
	/** Vacancies requiring each skill; the most required first, then by key. */
	skills: { skillKey: string; vacancies: number }[];
}

/** Required skills of the vacancies matching `where`, counted once per vacancy. */
export async function vacancySkillDemand(executor: Executor, where: SQL | undefined): Promise<VacancySkillDemand> {
	const [totals] = await executor
		.select({
			n: sql<number>`count(*)::int`,
			own: sql<number>`count(*) filter (where ${vacancies.origin} = 'own')::int`,
			external: sql<number>`count(*) filter (where ${vacancies.origin} = 'external')::int`,
			seeded: sql<boolean>`coalesce(bool_or(${vacancies.seedBatchId} is not null), false)`,
			latest: sql<Date | null>`max(${vacancySeenAt})`.mapWith(vacancies.createdAt)
		})
		.from(vacancies)
		.where(where);
	const rows = await executor
		.select({
			skillKey: sql<string>`skill`,
			n: sql<number>`count(distinct ${vacancies.id})::int`
		})
		.from(sql`${vacancies} cross join lateral unnest(${vacancies.requiredSkillKeys}) as skill`)
		.where(where)
		.groupBy(sql`skill`);
	if (!totals) throw new Error('an aggregate query returned no row');
	return {
		vacancies: totals.n,
		own: totals.own,
		external: totals.external,
		seeded: totals.seeded,
		latestSeenAt: totals.latest,
		skills: rows
			.map((row) => ({ skillKey: row.skillKey, vacancies: row.n }))
			.sort((a, b) => b.vacancies - a.vacancies || a.skillKey.localeCompare(b.skillKey))
	};
}

/**
 * Where the candidate stands with a skill the market asks for. Confirmed — a direct inference with an FSP or a platform
 * badge — is not a gap; everything else is: no inference, a claim of the resume, an inference derived from another
 * skill, a public profile nobody checked the skill in.
 */
export type DemandSkillStatus = 'missing' | 'claimed' | 'derived' | 'public_profile';

export interface DemandPath {
	/** Published platform tests checking the skill; `/me/tests/{assessmentId}`. */
	tests: { assessmentId: string; kind: 'code_task' | 'quiz'; title: string }[];
	/** FSP disciplines whose individual result confirms the skill directly, by the published taxonomy. */
	fspDisciplines: string[];
}

export interface DemandGap {
	skillKey: string;
	/** Vacancies of the cohort requiring the skill and their share of the cohort. */
	vacancies: number;
	share: number;
	status: DemandSkillStatus;
	path: DemandPath;
}

export interface DemandCohort {
	roleKey: string;
	/** The role of the category, or the desired one while the category has none. */
	roleBasis: 'established' | 'desired';
	/** Grades the cohort spans — the candidate's range and the next grade; `null` — every grade of the role. */
	gradeKeys: string[] | null;
	/** The grade cohort had fewer vacancies than the threshold, so the whole role was counted instead. */
	widenedFrom: { gradeKeys: string[]; vacancies: number } | null;
}

export type CandidateDemand =
	/** No category in force: the candidate's own side is unknown. */
	| { status: 'no_category' }
	/** Neither an established nor a desired role: no cohort to count. */
	| { status: 'no_role' }
	| { status: 'insufficient_data'; cohort: DemandCohort; vacancies: number; threshold: number; asOf: Date }
	| {
			status: 'available';
			cohort: DemandCohort;
			threshold: number;
			asOf: Date;
			source: Omit<VacancySkillDemand, 'skills' | 'seeded'> & { synthetic: boolean };
			gaps: DemandGap[];
			/** Skills of the most required ones the candidate has already confirmed. */
			confirmed: { skillKey: string; share: number }[];
	  };

/** Gaps shown: the most required skills the candidate has not confirmed. */
const GAPS_LIMIT = 8;
/** The most required skills of the cohort the confirmed ones are picked from. */
const TOP_CONFIRMED = 10;

const CONFIRMING_BADGES = new Set(['fsp_verified', 'platform_verified']);

function readableCandidate(subject: AccessSubject): string {
	const candidateId = subject.candidate?.id;
	if (candidateId === undefined) throw new ApiError('forbidden');
	const access = can(subject, 'candidate.self.read', { candidateId });
	if (!access.allowed) throw new ApiError(access.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
	return candidateId;
}

const textArray = (items: readonly string[]) =>
	sql`array[${sql.join(
		items.map((item) => sql`${item}`),
		sql`, `
	)}]::text[]`;

/** The vacancy's stated grade range meets the grades `window` of the ordered `scale`; an unknown grade never does. */
function gradeOverlap(scale: readonly string[], window: readonly string[]): SQL {
	const positions = window.map((key) => scale.indexOf(key) + 1);
	const low = Math.min(...positions);
	const high = Math.max(...positions);
	return sql`(array_position(${textArray(scale)}, ${vacancies.gradeMin}) <= ${high}
		and array_position(${textArray(scale)}, ${vacancies.gradeMax}) >= ${low})`;
}

export async function candidateDemand(executor: Executor, subject: AccessSubject, now: Date): Promise<CandidateDemand> {
	const candidateId = readableCandidate(subject);
	const snapshot = (await loadCandidateSnapshots(executor, [candidateId])).get(candidateId);
	if (!snapshot) throw new ApiError('not_found');
	const evidence = snapshot.evidence;
	if (evidence.status !== 'available') return { status: 'no_category' };

	const primary = evidence.categories.find((category) => category.rank === 'primary') ?? null;
	const desired = snapshot.desiredRoleKeys[0];
	const roleKey = primary?.roleKey ?? desired ?? null;
	if (roleKey === null) return { status: 'no_role' };
	const roleBasis = primary?.roleKey ? 'established' : 'desired';

	// The grade window: the candidate's range and the next grade — where the growth hint looks. The desired role has no
	// grade of its own, so it is counted across grades.
	const [run] = await executor
		.select({ taxonomyVersionId: categorizationRuns.taxonomyVersionId })
		.from(categorizationRuns)
		.where(eq(categorizationRuns.id, evidence.runId));
	if (!run) throw new Error(`run ${evidence.runId} disappeared`);
	const ordinals = (await loadGradeOrdinals(executor, [run.taxonomyVersionId])).get(run.taxonomyVersionId);
	if (!ordinals) throw new Error('grade ordinals were not loaded');
	const scale = [...ordinals.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => key);
	let gradeWindow: string[] | null = null;
	if (roleBasis === 'established' && primary?.grade) {
		const low = scale.indexOf(primary.grade.min);
		const high = scale.indexOf(primary.grade.max);
		if (low < 0 || high < 0)
			throw new Error(`grade range ${primary.grade.min}–${primary.grade.max} is not in the scale`);
		gradeWindow = scale.slice(low, Math.min(high + 2, scale.length));
	}

	const policy = await loadMarketPolicy(executor, now);
	const threshold = policy.threshold.vacancy_ranges;
	const reachable = and(
		matchableVacancyFor(await demoSessionOfUser(executor, subject.userId)),
		eq(vacancies.roleKey, roleKey)
	);
	let demand = await vacancySkillDemand(
		executor,
		gradeWindow === null ? reachable : and(reachable, gradeOverlap(scale, gradeWindow))
	);
	let cohort: DemandCohort = { roleKey, roleBasis, gradeKeys: gradeWindow, widenedFrom: null };
	if (gradeWindow !== null && demand.vacancies < threshold) {
		const widenedFrom = { gradeKeys: gradeWindow, vacancies: demand.vacancies };
		demand = await vacancySkillDemand(executor, reachable);
		cohort = { ...cohort, gradeKeys: null, widenedFrom };
	}
	if (demand.vacancies < threshold) {
		return { status: 'insufficient_data', cohort, vacancies: demand.vacancies, threshold, asOf: now };
	}

	const skills = new Map(evidence.skills.map((skill) => [skill.skillKey, skill]));
	const statusOf = (skillKey: string): DemandSkillStatus | 'confirmed' => {
		const skill = skills.get(skillKey);
		if (!skill) return 'missing';
		if (skill.attestation === 'claimed') return 'claimed';
		if (skill.attestation === 'derived') return 'derived';
		return skill.badgeTrust !== null && CONFIRMING_BADGES.has(skill.badgeTrust) ? 'confirmed' : 'public_profile';
	};
	const share = (count: number) => count / demand.vacancies;
	const ranked = demand.skills.map((row) => ({ ...row, status: statusOf(row.skillKey) }));
	const gapRows = ranked
		.filter((row): row is typeof row & { status: DemandSkillStatus } => row.status !== 'confirmed')
		.slice(0, GAPS_LIMIT);
	const paths = await confirmationPaths(
		executor,
		gapRows.map((row) => row.skillKey)
	);
	return {
		status: 'available',
		cohort,
		threshold,
		asOf: now,
		source: {
			vacancies: demand.vacancies,
			own: demand.own,
			external: demand.external,
			latestSeenAt: demand.latestSeenAt,
			synthetic: demand.seeded
		},
		gaps: gapRows.map((row) => ({
			skillKey: row.skillKey,
			vacancies: row.vacancies,
			share: share(row.vacancies),
			status: row.status,
			path: pathOf(paths, row.skillKey)
		})),
		confirmed: ranked
			.slice(0, TOP_CONFIRMED)
			.filter((row) => row.status === 'confirmed')
			.map((row) => ({ skillKey: row.skillKey, share: share(row.vacancies) }))
	};
}

function pathOf(paths: Map<string, DemandPath>, skillKey: string): DemandPath {
	const path = paths.get(skillKey);
	if (!path) throw new Error(`no confirmation path was built for ${skillKey}`);
	return path;
}

/** How each skill can be confirmed: published platform tests and FSP disciplines with a direct individual rule. */
async function confirmationPaths(executor: Executor, skillKeys: readonly string[]): Promise<Map<string, DemandPath>> {
	const result = new Map<string, DemandPath>(skillKeys.map((key) => [key, { tests: [], fspDisciplines: [] }]));
	if (skillKeys.length === 0) return result;
	for (const version of await publishedVersions(executor)) {
		for (const key of version.skillKeys) {
			result.get(key)?.tests.push({ assessmentId: version.assessmentId, kind: version.kind, title: version.title });
		}
	}
	const taxonomy = await latestPublishedVersion(executor);
	if (!taxonomy) throw new Error('a category is in force, yet no taxonomy is published');
	const rules = await executor
		.selectDistinct({ skillKey: fspProjectionRules.targetKey, discipline: fspProjectionRules.discipline })
		.from(fspProjectionRules)
		.where(
			and(
				eq(fspProjectionRules.taxonomyVersionId, taxonomy.id),
				eq(fspProjectionRules.targetKind, 'skill'),
				eq(fspProjectionRules.attestation, 'direct'),
				inArray(fspProjectionRules.targetKey, [...skillKeys])
			)
		);
	for (const rule of rules) result.get(rule.skillKey)?.fspDisciplines.push(rule.discipline);
	for (const path of result.values()) {
		path.tests.sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === 'code_task' ? -1 : 1));
		path.fspDisciplines.sort();
	}
	return result;
}
