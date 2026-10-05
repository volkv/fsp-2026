// «In the pool: N confirmed candidates» of a vacancy (docs/domain.md, section 13.3). The number is computed by
// `match.refresh` at the revision of the vacancy (`vacancies.pool_count`); here it is only read and shown: with the
// date of the calculation, below the small-count threshold as «< N», and «insufficient data» when the vacancy has no
// required skills: the pool counts confirmed required skills, and without them no candidate can be in it.
//
// Next to it, «M more match»: candidates whose stored match at the current revision reaches the pool threshold but whose
// required skills rest on no direct confirmation, so they are not in the pool. It is counted when read, from the
// stored matches, among the candidates any verified company could find — the same visibility the pool is counted in —
// and comes with the required skills a platform test confirms: what such a candidate could still prove.
//
// The count itself is `computeVacancyPool`, a function of the vacancy as matching sees it: `match.refresh` calls it for
// the stored revision, and `estimateVacancyPool` for a vacancy not saved yet — the draft from pasted text or the form
// being filled in — so the employer sees «≈N» before saving. An unsaved vacancy has no vector and no document yet, so
// the estimate is counted without the semantic component and with the reranker reading its title.
import { and, arrayOverlaps, desc, eq, inArray } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { listedInCatalog } from '$lib/server/db/conditions';
import {
	assessments,
	assessmentVersions,
	candidates,
	companies,
	matchScores,
	skills,
	vacancies
} from '$lib/server/db/schema';
import { demoScope } from '$lib/server/demo/scope';
import { uuidv7 } from '$lib/server/ids';
import { requiredPolicy } from '$lib/server/invitations/policies';
import type { VacancyForPosition } from '$lib/server/market/read';
import type { VacancySnapshot } from '$lib/server/matching/evidence';
import type { CallOptions } from '$lib/server/ml/adapter';
import { scoreCandidatesForVacancy, type VacancyScoring } from '$lib/server/matching/rank';
import { loadActiveMatchRuleset, type MatchRuleset } from '$lib/server/matching/ruleset';
import { qualifiesForPool, type MatchVacancy } from '$lib/server/matching/score';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { storedStatus } from '$lib/server/matching/storage';
import { loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import type { NamedKey } from '$lib/server/taxonomy/vocabulary';
import { catalogVisibleToAnyVerifiedCompany } from '$lib/server/visibility/can-show';

/** A count of candidates as the product shows it: exact, or «fewer than the threshold» for a small one. */
export type SmallCount = { status: 'counted'; count: number } | { status: 'below_threshold'; threshold: number };

export interface PoolMatching {
	/** Candidates at the pool threshold without a directly confirmed required skill. */
	unconfirmed: SmallCount;
	/** Required skills of the vacancy that a published platform test confirms, in the order of the vacancy. */
	confirmableSkills: NamedKey[];
}

/** The pool itself, without the matching candidates next to it. */
export type PoolCount =
	| { status: 'counted'; count: number; countedAt: Date }
	| { status: 'below_threshold'; threshold: number; countedAt: Date }
	| { status: 'insufficient_data' }
	/** Not computed yet for the current revision of the vacancy. */
	| { status: 'pending' };

type Counted = Extract<PoolCount, { countedAt: Date }>;

export type PoolCounter = Exclude<PoolCount, Counted> | (Counted & { matching: PoolMatching });

function smallCount(count: number, threshold: number): SmallCount {
	return count < threshold ? { status: 'below_threshold', threshold } : { status: 'counted', count };
}

/**
 * The pool is made of candidates with a required skill confirmed directly (`qualifiesForPool`): without required skills
 * the trust is unknown and nobody qualifies, whatever the role. The counter is then «insufficient data», not zero.
 */
export function hasPoolRequirements(vacancy: Pick<MatchVacancy, 'requiredSkillKeys'>): boolean {
	return vacancy.requiredSkillKeys.length > 0;
}

/** The small-count threshold of `catalog_policy`; without the policy the counter is refused, not guessed. */
async function smallCountThreshold(executor: Executor, now: Date): Promise<number> {
	return (await requiredPolicy(executor, 'catalog_policy', now)).params.small_count_threshold;
}

/** A candidate the catalog could show to some company: the pool of a vacancy is counted among them (domain 7.4, 13.3). */
const inCatalog = listedInCatalog(candidates);

/**
 * Candidates of the catalog within the reach of the company of a vacancy (domain 19.3): a company of a demo session —
 * those of its session and outside sessions; an external vacancy or a company outside sessions — those outside sessions.
 */
async function poolCandidateIds(executor: Executor, companyId: string | null): Promise<string[]> {
	let session: string | null = null;
	if (companyId !== null) {
		const [row] = await executor
			.select({ session: companies.demoSessionId })
			.from(companies)
			.where(eq(companies.id, companyId));
		if (!row) throw new Error(`company ${companyId} is missing`);
		session = row.session;
	}
	const rows = await executor
		.select({ id: candidates.id })
		.from(candidates)
		.where(and(inCatalog, demoScope(candidates, session)));
	return rows.map((row) => row.id);
}

interface VacancyPool {
	/** Every candidate within reach, scored against the vacancy. */
	scoring: VacancyScoring;
	/** Meaningful only with `hasPoolRequirements`; otherwise the counter is «insufficient data». */
	count: number;
}

/**
 * The pool of a vacancy: candidates within its reach, visible to some verified company (adults only), at the pool
 * threshold, with a required skill confirmed directly.
 */
export async function computeVacancyPool(
	executor: Executor,
	models: MatchingModels,
	vacancy: VacancySnapshot,
	options: CallOptions & { ruleset: MatchRuleset; now: Date }
): Promise<VacancyPool> {
	const { ruleset, now } = options;
	const candidateIds = await poolCandidateIds(executor, vacancy.companyId);
	const scoring = await scoreCandidatesForVacancy(executor, models, vacancy, candidateIds, {
		ruleset,
		...(options.priority ? { priority: options.priority } : {}),
		...(options.signal ? { signal: options.signal } : {})
	});
	options.signal?.throwIfAborted();
	const facts = await loadVisibilityFacts(executor, candidateIds, {
		now,
		policy: await loadVisibilityPolicy(executor, now),
		viewerCompanyId: null
	});
	const count = scoring.ranked.filter(({ snapshot, result }) => {
		const fact = facts.get(snapshot.id);
		return (
			fact !== undefined &&
			catalogVisibleToAnyVerifiedCompany(fact) &&
			qualifiesForPool(result.score, result.components.trust, ruleset.params)
		);
	}).length;
	return { scoring, count };
}

/** A vacancy not saved yet, as the draft or the form states it: a field it does not state is `null` or empty. */
export interface UnsavedVacancy extends VacancyForPosition {
	requiredSkillKeys: readonly string[];
	title: string;
	description: string | null;
	niceSkillKeys: readonly string[];
	workFormat: string | null;
	taxonomyVersionId: string;
}

/** The estimate of the pool of an unsaved vacancy: a small count, or «insufficient data» without required skills. */
type PoolEstimate = SmallCount | { status: 'insufficient_data' };

/**
 * «≈N confirmed candidates» of a vacancy the company is writing, before it is saved: the same count as the pool of a
 * saved vacancy, within the reach of the company (a demo session counts its own candidates too), with the threshold
 * of small counts. Nothing is written.
 */
export async function estimateVacancyPool(
	executor: Executor,
	models: MatchingModels,
	companyId: string,
	unsaved: UnsavedVacancy,
	options: { now: Date; signal?: AbortSignal }
): Promise<PoolEstimate> {
	const threshold = await smallCountThreshold(executor, options.now);
	if (!hasPoolRequirements(unsaved)) return { status: 'insufficient_data' };
	const vacancy: VacancySnapshot = {
		id: uuidv7(),
		revision: 0,
		origin: 'own',
		companyId,
		status: 'draft',
		title: unsaved.title,
		description: unsaved.description,
		taxonomyVersionId: unsaved.taxonomyVersionId,
		workFormat: unsaved.workFormat,
		minAge: null,
		supersededByVacancyId: null,
		publishedAt: null,
		roleKey: unsaved.roleKey,
		grade:
			unsaved.gradeMin !== null && unsaved.gradeMax !== null ? { min: unsaved.gradeMin, max: unsaved.gradeMax } : null,
		requiredSkillKeys: unsaved.requiredSkillKeys,
		niceSkillKeys: unsaved.niceSkillKeys,
		salary: unsaved.salary
	};
	const { count } = await computeVacancyPool(executor, models, vacancy, {
		ruleset: await loadActiveMatchRuleset(executor),
		now: options.now,
		priority: 'interactive',
		...(options.signal ? { signal: options.signal } : {})
	});
	return smallCount(count, threshold);
}

interface PoolVacancy {
	id: string;
	revision: number;
	taxonomyVersionId: string;
	requiredSkillKeys: readonly string[];
}

/**
 * Candidates at the pool threshold that the pool leaves out for want of a direct confirmation: by the latest stored
 * match of each candidate at the current revision and rule set, among those visible to some verified company.
 */
async function countUnconfirmed(executor: Executor, vacancy: PoolVacancy, now: Date): Promise<number> {
	const ruleset = await loadActiveMatchRuleset(executor);
	const rows = await executor
		.selectDistinctOn([matchScores.candidateId], {
			candidateId: matchScores.candidateId,
			score: matchScores.score,
			componentStatuses: matchScores.componentStatuses,
			trustValue: matchScores.trustValue
		})
		.from(matchScores)
		.where(
			and(
				eq(matchScores.vacancyId, vacancy.id),
				eq(matchScores.vacancyRevision, vacancy.revision),
				eq(matchScores.matchRulesetId, ruleset.id)
			)
		)
		.orderBy(matchScores.candidateId, desc(matchScores.computedAt));
	const unconfirmed = rows.filter((row) => {
		const score = Number(row.score);
		const trust = { status: storedStatus(row.componentStatuses, 'trust'), value: row.trustValue };
		return score >= ruleset.params.poolThreshold && !qualifiesForPool(score, trust, ruleset.params);
	});
	if (unconfirmed.length === 0) return 0;
	const facts = await loadVisibilityFacts(
		executor,
		unconfirmed.map((row) => row.candidateId),
		{ now, policy: await loadVisibilityPolicy(executor, now), viewerCompanyId: null }
	);
	return unconfirmed.filter((row) => {
		const fact = facts.get(row.candidateId);
		return fact !== undefined && catalogVisibleToAnyVerifiedCompany(fact);
	}).length;
}

/** Required skills of the vacancy covered by a published assessment, named as in the vacancy's taxonomy version. */
async function confirmableSkills(executor: Executor, vacancy: PoolVacancy): Promise<NamedKey[]> {
	if (vacancy.requiredSkillKeys.length === 0) return [];
	const covered = new Set(
		(
			await executor
				.selectDistinct({ skillKeys: assessments.skillKeys })
				.from(assessments)
				.innerJoin(assessmentVersions, eq(assessmentVersions.assessmentId, assessments.id))
				.where(
					and(
						eq(assessmentVersions.status, 'published'),
						arrayOverlaps(assessments.skillKeys, [...vacancy.requiredSkillKeys])
					)
				)
		).flatMap((row) => row.skillKeys)
	);
	const keys = vacancy.requiredSkillKeys.filter((key) => covered.has(key));
	if (keys.length === 0) return [];
	const names = new Map(
		(
			await executor
				.select({ key: skills.key, name: skills.name })
				.from(skills)
				.where(and(eq(skills.taxonomyVersionId, vacancy.taxonomyVersionId), inArray(skills.key, keys)))
		).map((row) => [row.key, row.name])
	);
	return keys.map((key) => {
		const name = names.get(key);
		if (name === undefined) throw new Error(`skill ${key} of vacancy ${vacancy.id} is not in its taxonomy version`);
		return { key, name };
	});
}

interface PoolRead {
	pool: PoolCount;
	vacancy: PoolVacancy;
	threshold: number;
}

async function readPool(executor: Executor, vacancyId: string, now: Date): Promise<PoolRead | null> {
	const [row] = await executor
		.select({
			id: vacancies.id,
			revision: vacancies.revision,
			taxonomyVersionId: vacancies.taxonomyVersionId,
			poolCount: vacancies.poolCount,
			poolCountedAt: vacancies.poolCountedAt,
			requiredSkillKeys: vacancies.requiredSkillKeys
		})
		.from(vacancies)
		.where(eq(vacancies.id, vacancyId));
	if (!row) return null;
	const threshold = await smallCountThreshold(executor, now);
	const read = (pool: PoolCount): PoolRead => ({ pool, vacancy: row, threshold });
	if (!hasPoolRequirements(row)) return read({ status: 'insufficient_data' });
	// Before the refresh of this revision there is neither the count nor stored matches of it to count from.
	if (row.poolCount === null || row.poolCountedAt === null) return read({ status: 'pending' });
	return read({ ...smallCount(row.poolCount, threshold), countedAt: row.poolCountedAt });
}

/** The pool of a vacancy without the matching candidates, for readers that do not show them; `null` — no such vacancy. */
export async function loadPoolCount(executor: Executor, vacancyId: string, now: Date): Promise<PoolCount | null> {
	return (await readPool(executor, vacancyId, now))?.pool ?? null;
}

/** The pool counter of a vacancy with the matching candidates next to it; `null` — no such vacancy. */
export async function loadPoolCounter(executor: Executor, vacancyId: string, now: Date): Promise<PoolCounter | null> {
	const read = await readPool(executor, vacancyId, now);
	if (!read) return null;
	const { pool, vacancy, threshold } = read;
	if (pool.status === 'insufficient_data' || pool.status === 'pending') return pool;
	const [unconfirmed, confirmable] = await Promise.all([
		countUnconfirmed(executor, vacancy, now),
		confirmableSkills(executor, vacancy)
	]);
	return { ...pool, matching: { unconfirmed: smallCount(unconfirmed, threshold), confirmableSkills: confirmable } };
}
