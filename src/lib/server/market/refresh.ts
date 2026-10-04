// `market.refresh` (docs/domain.md, sections 12.5, 17.2): recomputes `market_snapshots` of every category the data
// speaks about and replaces the previous set in one transaction. The candidate indicator here counts candidates any
// verified company could find in the catalog; a company sees the indicator over the candidates it sees, computed on
// request (`read.ts`).
import { marketSnapshots } from '$lib/server/db/schema';
import type { Executor, Transaction } from '$lib/server/db';
import { defineHandler, JobFailure } from '$lib/server/jobs/handler';
import { catalogVisibleToAnyVerifiedCompany } from '$lib/server/visibility/can-show';
import { loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import { aggregate, categoryKey, salaryPoint, type MarketInput, type SnapshotRow } from './aggregate';
import { loadCandidateRecords, loadSalaryReferences, loadVacancyRecords, type SalaryReferenceRow } from './inputs';
import { loadMarketPolicy, MarketPolicyMissing, type MarketPolicy } from './policy';

/** The market of the platform is country-wide: one geography until the brief asks for regions. */
export const MARKET_GEOGRAPHY = 'ru';

const DAY_MS = 86_400_000;
const isoDate = (value: Date) => value.toISOString().slice(0, 10);

/** Rows per insert statement. */
const BATCH = 500;

const OBSERVED_METHOD = 'observed_median';
export const ESTIMATED_METHOD = 'estimated_stack_adjustment';

/**
 * Snapshot rows of the external reference. An observed row is stored as the source gives it. An estimated row
 * (a stack premium applied to the role × grade median) carries only a median in the source; its quartiles are the
 * quartiles of the same role × grade scaled by the same premium, so the whole row stays one estimate with
 * `estimated = true`. An estimated row without an observed base with quartiles is not stored.
 */
export function referenceSnapshots(
	references: readonly SalaryReferenceRow[],
	threshold: number,
	computedAt: Date
): { rows: SnapshotRow[]; skipped: number } {
	const baseOf = new Map(
		references
			.filter((r) => r.method === OBSERVED_METHOD && r.skillKey === null)
			.map((r) => [`${r.roleKey}|${r.gradeKey ?? ''}|${r.currency}|${r.period}|${r.taxBase}|${r.source}`, r])
	);
	const rows: SnapshotRow[] = [];
	let skipped = 0;
	for (const reference of references) {
		if (reference.method !== OBSERVED_METHOD && reference.method !== ESTIMATED_METHOD) {
			throw new Error(`salary reference ${reference.id} has an unknown method ${reference.method}`);
		}
		const estimated = reference.method === ESTIMATED_METHOD;
		let quartiles: { p25: number | null; p75: number | null } = { p25: reference.p25, p75: reference.p75 };
		if (estimated) {
			const base = baseOf.get(
				`${reference.roleKey}|${reference.gradeKey ?? ''}|${reference.currency}|${reference.period}|${reference.taxBase}|${reference.source}`
			);
			if (reference.median === null || !base?.median || base.p25 === null || base.p75 === null) {
				skipped++;
				continue;
			}
			const premium = reference.median / base.median;
			quartiles = { p25: Math.round(base.p25 * premium), p75: Math.round(base.p75 * premium) };
		}
		const enough =
			reference.sampleSize >= threshold &&
			reference.median !== null &&
			quartiles.p25 !== null &&
			quartiles.p75 !== null;
		const collected = isoDate(reference.collectedAt);
		rows.push({
			indicator: 'external_reference',
			categoryKey: categoryKey({
				roleKey: reference.roleKey,
				gradeKey: reference.gradeKey,
				stackSkillKeys: reference.skillKey === null ? [] : [reference.skillKey]
			}),
			geography: reference.geography,
			currency: reference.currency,
			period: reference.period,
			taxBase: reference.taxBase,
			sampleSize: reference.sampleSize,
			median: enough ? reference.median : null,
			p25: enough ? quartiles.p25 : null,
			p75: enough ? quartiles.p75 : null,
			windowFrom: collected,
			windowTo: collected,
			method: reference.method,
			estimated,
			status: enough ? 'ok' : 'insufficient_data',
			provenance: 'live',
			computedAt
		});
	}
	return { rows, skipped };
}

/** Candidate inputs: expectations of catalog candidates the visibility predicate keeps. */
export function candidateInputs(
	records: Awaited<ReturnType<typeof loadCandidateRecords>>,
	visible: (candidateId: string) => boolean
): MarketInput[] {
	return records.flatMap((record) => {
		const point = salaryPoint(record.salary);
		if (point === null || !visible(record.candidateId)) return [];
		return [{ indicator: 'candidate_expectations' as const, keys: record.keys, point, synthetic: record.synthetic }];
	});
}

export function vacancyInputs(records: Awaited<ReturnType<typeof loadVacancyRecords>>): MarketInput[] {
	return records.flatMap((record) => {
		const point = salaryPoint(record.salary);
		if (point === null) return [];
		return [{ indicator: 'vacancy_ranges' as const, keys: record.keys, point, synthetic: record.synthetic }];
	});
}

/** Every snapshot row of the market at `now`. */
export async function computeMarket(
	executor: Executor,
	policy: MarketPolicy,
	now: Date
): Promise<{ rows: SnapshotRow[]; skippedReferences: number }> {
	const windowFrom = new Date(now.getTime() - policy.windowDays * DAY_MS);
	const candidates = await loadCandidateRecords(executor);
	const facts = await loadVisibilityFacts(
		executor,
		candidates.map((record) => record.candidateId),
		{ now, policy: await loadVisibilityPolicy(executor, now), viewerCompanyId: null }
	);
	const visible = (id: string) => {
		const fact = facts.get(id);
		return fact !== undefined && catalogVisibleToAnyVerifiedCompany(fact);
	};
	const vacancies = await loadVacancyRecords(executor, windowFrom);
	const observed = [
		...aggregate(candidateInputs(candidates, visible), {
			threshold: policy.threshold,
			geography: MARKET_GEOGRAPHY,
			window: { from: isoDate(now), to: isoDate(now) },
			computedAt: now
		}),
		...aggregate(vacancyInputs(vacancies), {
			threshold: policy.threshold,
			geography: MARKET_GEOGRAPHY,
			window: { from: isoDate(windowFrom), to: isoDate(now) },
			computedAt: now
		})
	];
	const references = referenceSnapshots(await loadSalaryReferences(executor), policy.threshold.external_reference, now);
	return { rows: [...observed, ...references.rows], skippedReferences: references.skipped };
}

/** Replaces the stored snapshots with a new set. */
export async function storeMarket(tx: Transaction, rows: readonly SnapshotRow[]): Promise<void> {
	await tx.delete(marketSnapshots);
	for (let i = 0; i < rows.length; i += BATCH) {
		await tx.insert(marketSnapshots).values(rows.slice(i, i + BATCH));
	}
}

/** Handler of `market.refresh` for the job registry. */
export const marketRefresh = defineHandler({
	type: 'market.refresh',
	concurrency: 1,
	run: async ({ db, signal }) => {
		const now = new Date();
		let policy: MarketPolicy;
		try {
			policy = await loadMarketPolicy(db, now);
		} catch (error) {
			if (error instanceof MarketPolicyMissing) {
				throw new JobFailure('market_policy_missing', error.message, { retryable: false });
			}
			throw error;
		}
		const market = await computeMarket(db, policy, now);
		signal.throwIfAborted();
		return {
			// The market is a picture of the moment it was read; a newer run replaces it as a whole.
			isCurrent: () => Promise.resolve(true),
			write: (tx) => storeMarket(tx, market.rows),
			describe: () => ({
				rows: market.rows.length,
				ok: market.rows.filter((row) => row.status === 'ok').length,
				skipped_references: market.skippedReferences
			})
		};
	}
});
