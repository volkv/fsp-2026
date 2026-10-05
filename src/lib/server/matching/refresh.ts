// `match.refresh` (docs/domain.md, sections 13.3, 13.4, 17): recomputes the matches of one vacancy against the catalog,
// or of one candidate against the vacancies, keeps the significant ones in `match_scores` (`storage.ts`) and the pool
// counter of vacancies. A row is written only for the revisions it was computed from and only while the candidate's
// evidence floor does not exceed its revision: a withdrawal committed before the write makes the row invalid from birth
// and it is not stored. Pairs are made within the reach of demo sessions (domain 19.3): a vacancy of a demo company is
// matched with the candidates of its session and outside sessions, a vacancy outside sessions with the candidates
// outside sessions only — the candidates its company can see, so the pool counter counts them. The candidate side makes
// the same pairs: a clone only with the vacancies of the companies of its session.
import { and, eq, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '$lib/server/db';
import { listedInCatalog } from '$lib/server/db/conditions';
import { candidates, vacancies } from '$lib/server/db/schema';
import { companySession } from '$lib/server/demo/scope';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { enqueueJob } from '$lib/server/jobs/queue';
import { modelAdapter } from '$lib/server/ml';
import { computeVacancyPool, hasPoolRequirements } from '$lib/server/vacancies/pool';
import {
	loadCandidateSnapshots,
	loadGradeOrdinals,
	matchableVacancy,
	loadVacancySnapshot,
	vacancySnapshot
} from './evidence';
import type { CandidateSnapshot, VacancySnapshot } from './evidence';
import { loadActiveMatchRuleset, MatchRulesetError, type MatchRuleset } from './ruleset';
import { matchScore, qualifiesForPool, type MatchResult } from './score';
import { loadActiveSpace, pairKey, pairSimilarities, semanticSignal, type MatchingModels } from './semantic';
import {
	clearVacancy,
	isSignificant,
	loadMatchStoragePolicy,
	MatchStorageError,
	pruneCandidate,
	pruneVacancy,
	storedPoolMembership,
	writePairs,
	type ComputedPair,
	type MatchStoragePolicy
} from './storage';

const stale: JobResult = { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };

async function activeRuleset(executor: Executor): Promise<MatchRuleset> {
	try {
		return await loadActiveMatchRuleset(executor);
	} catch (error) {
		if (error instanceof MatchRulesetError) throw new JobFailure(error.code, error.message, { retryable: true });
		throw error;
	}
}

async function storagePolicy(executor: Executor, ruleset: MatchRuleset): Promise<MatchStoragePolicy> {
	try {
		return await loadMatchStoragePolicy(executor, ruleset, new Date());
	} catch (error) {
		if (error instanceof MatchStorageError) {
			throw new JobFailure(error.code, error.message, { retryable: error.code === 'policy_missing' });
		}
		throw error;
	}
}

/** A candidate the catalog could show to some company: out of it the candidate is in no pool (domain 7.4, 13.3). */
const inCatalog = listedInCatalog(candidates);

/** A vacancy the pool and the matches are kept for; a closed, hidden or replaced one is left as it is. */
function refreshable(vacancy: VacancySnapshot): boolean {
	if (vacancy.origin === 'own') return vacancy.status !== 'closed';
	return (vacancy.status === 'active' || vacancy.status === 'stale') && vacancy.supersededByVacancyId === null;
}

function computedPair(
	vacancy: VacancySnapshot,
	candidate: CandidateSnapshot,
	result: MatchResult,
	spaceId: string | null
): ComputedPair {
	return {
		vacancyId: vacancy.id,
		vacancyRevision: vacancy.revision,
		candidateId: candidate.id,
		candidateRevision: candidate.revision,
		evidenceRunId: candidate.evidence.status === 'available' ? candidate.evidence.runId : null,
		result,
		spaceId: result.components.semantic.status === 'computed' ? spaceId : null
	};
}

async function refreshVacancy(
	executor: Executor,
	models: MatchingModels,
	vacancyId: string,
	jobId: string,
	signal: AbortSignal
): Promise<JobResult> {
	const vacancy = await loadVacancySnapshot(executor, vacancyId);
	if (!vacancy) return stale;
	const isCurrent = async (tx: Transaction) => {
		const [row] = await tx
			.select({ revision: vacancies.revision })
			.from(vacancies)
			.where(eq(vacancies.id, vacancyId))
			.for('update');
		return row?.revision === vacancy.revision;
	};
	if (!refreshable(vacancy)) {
		// Nobody is matched with it any more: its rows go, except those an invitation refers to.
		let removed = 0;
		return {
			isCurrent,
			write: async (tx) => {
				removed = await clearVacancy(tx, vacancy.id);
			},
			describe: () => ({ skipped: vacancy.status, removed })
		};
	}

	const ruleset = await activeRuleset(executor);
	const policy = await storagePolicy(executor, ruleset);
	const { scoring, count } = await computeVacancyPool(executor, models, vacancy, {
		ruleset,
		now: new Date(),
		priority: 'background',
		signal
	});
	// Without required skills nobody can be in the pool: the counter is «insufficient data», not zero.
	const pool = hasPoolRequirements(vacancy) ? count : null;

	const spaceId = scoring.semantic.space?.id ?? null;
	const significant = scoring.ranked
		.filter(({ result }) => isSignificant(result, policy))
		.map(({ snapshot, result }) => computedPair(vacancy, snapshot, result, spaceId));
	let stored = 0;
	let written = 0;
	let removed = 0;
	return {
		isCurrent,
		write: async (tx) => {
			const outcome = await writePairs(tx, significant, ruleset, jobId, 'replace_changed');
			stored = outcome.kept.length;
			written = outcome.written;
			removed = await pruneVacancy(tx, vacancy.id, outcome.kept, ruleset);
			await tx
				.update(vacancies)
				.set(pool === null ? { poolCount: null, poolCountedAt: null } : { poolCount: pool, poolCountedAt: new Date() })
				.where(and(eq(vacancies.id, vacancy.id), eq(vacancies.revision, vacancy.revision)));
		},
		describe: () => ({
			candidates: scoring.ranked.length,
			stored,
			written,
			removed,
			pool,
			reranker: scoring.reranker.status,
			semantic: scoring.semantic.space ? 'computed' : scoring.semantic.reason
		})
	};
}

async function refreshCandidate(executor: Executor, candidateId: string, jobId: string): Promise<JobResult> {
	const snapshot = (await loadCandidateSnapshots(executor, [candidateId])).get(candidateId);
	if (!snapshot) return stale;
	const ruleset = await activeRuleset(executor);
	const policy = await storagePolicy(executor, ruleset);
	// Out of the catalog the candidate is in no pool and no pair of theirs is kept (the vacancy side does the same).
	const listed =
		(
			await executor
				.select({ id: candidates.id })
				.from(candidates)
				.where(and(eq(candidates.id, candidateId), inCatalog))
		).length > 0;

	// The pairs the vacancy side makes too: a clone only with the vacancies of its own session's companies, an original
	// of the scenario heroes only with the vacancies outside sessions.
	const [own] = await executor
		.select({ session: candidates.demoSessionId, original: candidates.demoOriginal })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!own) return stale;
	const sessionOfVacancy = companySession(vacancies.companyId);
	const reach =
		own.session !== null
			? sql`${sessionOfVacancy} = ${own.session}::uuid`
			: own.original
				? sql`${sessionOfVacancy} is null`
				: undefined;
	const rows = await executor.select().from(vacancies).where(and(matchableVacancy, reach));
	const vacancyList = rows.map(vacancySnapshot);
	const ordinals = await loadGradeOrdinals(
		executor,
		vacancyList.map((v) => v.taxonomyVersionId)
	);
	const space = await loadActiveSpace(executor);
	const similarities =
		space === null
			? new Map<string, number>()
			: await pairSimilarities(
					executor,
					space,
					vacancyList.map((v) => v.id),
					[candidateId]
				);

	const pairs = vacancyList.map((vacancy) => {
		const gradeOrdinals = ordinals.get(vacancy.taxonomyVersionId);
		if (!gradeOrdinals) throw new Error('grade ordinals were not loaded');
		const result = matchScore({
			vacancy,
			candidate: snapshot,
			params: ruleset.params,
			gradeOrdinals,
			semantic: semanticSignal(space, similarities.get(pairKey(vacancy.id, candidateId)), 'pair_vector_missing'),
			// One candidate against many vacancies would take a reranker call per vacancy (see recommendations).
			reranker: { status: 'unavailable', reason: 'pair_not_reranked' }
		});
		return computedPair(vacancy, snapshot, result, space?.id ?? null);
	});

	// Vacancies whose pool may change: the pair qualifies now and did not before, or the other way round.
	const before = await storedPoolMembership(
		executor,
		candidateId,
		vacancyList.map((v) => v.id),
		ruleset
	);
	const changed = pairs.filter(
		(pair) =>
			(listed && qualifiesForPool(pair.result.score, pair.result.components.trust, ruleset.params)) !==
			(before.get(pair.vacancyId) ?? false)
	);
	const significant = listed ? pairs.filter((pair) => isSignificant(pair.result, policy)) : [];

	let stored = 0;
	let written = 0;
	let removed = 0;
	return {
		isCurrent: async (tx) => {
			const [row] = await tx
				.select({ revision: candidates.profileRevision, floor: candidates.evidenceFloorRevision })
				.from(candidates)
				.where(eq(candidates.id, candidateId))
				.for('update');
			return row?.revision === snapshot.revision && row.floor <= snapshot.revision;
		},
		write: async (tx) => {
			const outcome = await writePairs(tx, significant, ruleset, jobId, 'keep_existing');
			stored = outcome.kept.length;
			written = outcome.written;
			removed = await pruneCandidate(
				tx,
				{
					candidateId,
					revision: snapshot.revision,
					evidenceRunId: snapshot.evidence.status === 'available' ? snapshot.evidence.runId : null
				},
				vacancyList.map((v) => v.id),
				outcome.kept,
				ruleset
			);
			for (const pair of changed) {
				await enqueueJob(
					tx,
					'match.refresh',
					{ scope: 'vacancy', vacancy_id: pair.vacancyId },
					{ inputVersion: String(pair.vacancyRevision), createdBy: { kind: 'system' } }
				);
			}
		},
		describe: () => ({ vacancies: pairs.length, stored, written, removed, pool_changes: changed.length })
	};
}

/** Builds the handler over the model adapter; the registered handler uses the configured one. */
export function createMatchRefreshHandler(models: () => MatchingModels): JobHandler<'match.refresh'> {
	return defineHandler({
		type: 'match.refresh',
		concurrency: 2,
		run: async ({ job, db, signal }) => {
			const payload = job.payload;
			return payload.scope === 'vacancy'
				? refreshVacancy(db, models(), payload.vacancy_id, job.id, signal)
				: refreshCandidate(db, payload.candidate_id, job.id);
		}
	});
}

/** Handler of `match.refresh` for the job registry. */
export const matchRefresh = createMatchRefreshHandler(modelAdapter);
