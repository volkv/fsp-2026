// Job `derivations.reconcile` (docs/domain.md, section 17.3): the hourly safety net of the derived data of candidates
// and of the pools of vacancies. The main path is the transactional enqueue with merging (17.1); this job finds a
// derivation that lags behind its inputs and has no job waiting or running, and enqueues it. The inputs are the profile
// revision and the rule set in force: a derivation computed on a rule set published before the current one lags too,
// whatever revision it stands on. A job this schedule enqueued once for a revision under a rule set is not enqueued
// again for them: a derivation that cannot be computed (a failing model, a candidate the job skips) stays visible as its
// failed job instead of being retried every hour; the next change of the profile or of the rule set makes it due again.
// A run enqueues a bounded number of jobs; a run that found more enqueues its own continuation, so a new rule set that
// makes every derivation lag is caught up run after run rather than hour after hour.
import { sql, type SQL } from 'drizzle-orm';
import type { Executor, Transaction } from '$lib/server/db';
import { publishedRun, runAt } from '$lib/server/db/conditions';
import { defineHandler, type JobHandler } from '$lib/server/jobs/handler';
import { enqueueJob, type JobCreator } from '$lib/server/jobs/queue';
import { jobSpec } from '$lib/server/jobs/registry';

/** The derivations of a candidate's profile the reconciliation keeps up with the profile revision. */
export const RECONCILED_TYPES = ['evidence.compute', 'profile.embed', 'match.refresh'] as const;
export type ReconciledType = (typeof RECONCILED_TYPES)[number];

/** Candidates whose derivations are computed; a profile being deleted is left to its removal. */
const RECONCILED_STATUSES = ['onboarding', 'active', 'ineligible_age'] as const;

/** Candidates or vacancies read per query. */
const BATCH_SIZE = 500;
/** Jobs one run enqueues at most; the rest are found by the continuation of the run. */
export const MAX_ENQUEUED_PER_RUN = 2000;

/** Marks the jobs this schedule enqueued (`jobs.created_by`), so a revision is reconciled once. */
const CREATOR: JobCreator = { kind: 'system', id: 'derivations.reconcile' };

const PROBE_ID = '00000000-0000-4000-8000-000000000000';

/** The key ends with the owner id: the prefix lets the query build the keys of a whole page. */
function prefixOf(key: string, type: string): string {
	if (!key.endsWith(PROBE_ID)) throw new Error(`dedup key of ${type} does not end with the owner id`);
	return key.slice(0, -PROBE_ID.length);
}

/** The deduplication key prefix of a derivation's job for a candidate, as the registry builds it. */
function candidateKeyPrefix(type: ReconciledType): string {
	switch (type) {
		case 'evidence.compute':
		case 'profile.embed':
			return prefixOf(jobSpec(type).dedupKey({ candidate_id: PROBE_ID }), type);
		case 'match.refresh':
			return prefixOf(jobSpec(type).dedupKey({ scope: 'candidate', candidate_id: PROBE_ID }), type);
	}
}

const VACANCY_KEY_PREFIX = prefixOf(
	jobSpec('match.refresh').dedupKey({ scope: 'vacancy', vacancy_id: PROBE_ID }),
	'match.refresh'
);

/**
 * The rule set a derivation is computed on, as its job reads it: the categorization rule set of the highest version
 * over a published taxonomy (a new taxonomy release always comes with new rule sets), the match rule set of the highest
 * version. `since` — the moment it was stored, as the database text of the timestamp (microseconds kept): a job created
 * after it reads this rule set, since the publication stores it under a lock that orders every later job after its
 * commit (`taxonomy/publish.ts`).
 */
interface RulesetBasis {
	id: string;
	since: string;
}

interface Bases {
	categorization: RulesetBasis | null;
	match: RulesetBasis | null;
}

async function loadBases(executor: Executor): Promise<Bases> {
	const [row] = await executor.execute<{
		categorization_id: string | null;
		categorization_since: string | null;
		match_id: string | null;
		match_since: string | null;
	}>(sql`
		select c.id as categorization_id, c.created_at::text as categorization_since,
			m.id as match_id, m.created_at::text as match_since
		from (select 1) one
		left join lateral (
			select r.id, r.created_at from categorization_rulesets r
			join taxonomy_versions t on t.id = r.taxonomy_version_id and t.status = 'published'
			order by r.version desc limit 1
		) c on true
		left join lateral (select r.id, r.created_at from match_rulesets r order by r.version desc limit 1) m on true
	`);
	if (!row) throw new Error('rule set bases were not read');
	const basis = (id: string | null, since: string | null): RulesetBasis | null =>
		id === null || since === null ? null : { id, since };
	return {
		categorization: basis(row.categorization_id, row.categorization_since),
		match: basis(row.match_id, row.match_since)
	};
}

/**
 * Without a rule set in force the derivation is reconciled by the revision alone; its job fails visibly until one is
 * published.
 */
function sinceOf(basis: RulesetBasis | null): SQL {
	return basis === null ? sql`'-infinity'::timestamptz` : sql`${basis.since}::timestamptz`;
}

/**
 * The revision the stored result of a derivation stands on, besides its succeeded jobs, for the candidate `b.id` of
 * the page: the published evidence run of the rule set in force, the candidate's vectors in a space being built or in use,
 * the candidate's match rows of the rule set in force.
 */
function storedRevision(type: ReconciledType, bases: Bases): SQL {
	switch (type) {
		case 'evidence.compute':
			return sql`(select max(r.input_revision) from evidence_runs r
				where r.candidate_id = b.id and ${publishedRun(runAt('r'))}
					${bases.categorization === null ? sql`` : sql`and r.ruleset_id = ${bases.categorization.id}::uuid`})`;
		case 'profile.embed':
			return sql`(select max(e.input_version::bigint) from embeddings e
				join embedding_spaces s on s.id = e.space_id and s.status in ('building', 'active')
				where e.owner_type = 'candidate_section' and e.owner_id = b.id::text)`;
		case 'match.refresh':
			return sql`(select max(m.candidate_revision) from match_scores m
				where m.candidate_id = b.id
					${bases.match === null ? sql`` : sql`and m.match_ruleset_id = ${bases.match.id}::uuid`})`;
	}
}

function basisSince(type: ReconciledType, bases: Bases): SQL {
	switch (type) {
		case 'evidence.compute':
			return sinceOf(bases.categorization);
		case 'profile.embed':
			return sinceOf(null);
		case 'match.refresh':
			return sinceOf(bases.match);
	}
}

/**
 * The job history of the keyed rows `k` (`dedup_key`, `revision`, `since`): the highest revision a job created under
 * the rule set in force succeeded for, whether a job waits or runs, whether this schedule already enqueued the revision
 * under the rule set. Jobs are read once per page and matched by key.
 */
const HISTORY = sql`
	history as (
		select k.dedup_key,
			max(j.input_version::bigint) filter (where j.status = 'succeeded' and j.created_at > k.since)
				as succeeded_revision,
			bool_or(j.status in ('queued', 'running')) as pending,
			bool_or(j.created_by ->> 'id' = ${CREATOR.id} and j.input_version = k.revision::text
				and j.created_at > k.since) as reconciled
		from keyed k
		join jobs j on j.dedup_key = k.dedup_key
		group by k.dedup_key
	)`;

type DueDerivation =
	| { scope: 'candidate'; candidateId: string; type: ReconciledType; revision: number }
	| { scope: 'vacancy'; vacancyId: string; revision: number };

interface Page {
	due: DueDerivation[];
	/** The last id of the page; `null` — nothing left. */
	last: string | null;
}

/** One page of candidates after `after`, with the derivations due for each. */
async function candidatePage(executor: Executor, bases: Bases, after: string | null): Promise<Page> {
	const rows = await executor.execute<{
		id: string;
		type: ReconciledType;
		revision: string;
		processed: string | null;
		pending: boolean;
		reconciled: boolean;
	}>(sql`
		with batch as (
			select c.id, c.profile_revision as revision
			from candidates c
			where c.status in (${sql.join(
				RECONCILED_STATUSES.map((status) => sql`${status}`),
				sql`, `
			)})
				and c.profile_revision > 0
				${after === null ? sql`` : sql`and c.id > ${after}::uuid`}
			order by c.id
			limit ${BATCH_SIZE}
		),
		keyed as (
			${sql.join(
				RECONCILED_TYPES.map(
					(type) => sql`
						select b.id, b.revision, ${type}::text as type, ${candidateKeyPrefix(type)} || b.id::text as dedup_key,
							${basisSince(type, bases)} as since, ${storedRevision(type, bases)} as stored_revision
						from batch b`
				),
				sql` union all `
			)}
		),
		${HISTORY}
		select k.id, k.type, k.revision::text as revision,
			greatest(k.stored_revision, h.succeeded_revision)::text as processed,
			coalesce(h.pending, false) as pending,
			coalesce(h.reconciled, false) as reconciled
		from keyed k
		left join history h on h.dedup_key = k.dedup_key
		order by k.id, k.type
	`);
	const due: DueDerivation[] = [];
	for (const row of rows) {
		const revision = Number(row.revision);
		const lagging = row.processed === null || Number(row.processed) < revision;
		if (lagging && !row.pending && !row.reconciled) {
			due.push({ scope: 'candidate', candidateId: row.id, type: row.type, revision });
		}
	}
	return { due, last: rows.at(-1)?.id ?? null };
}

/**
 * One page of vacancies after `after` whose pool or stored matches may stand on a match rule set before the one in
 * force: a counted pool or a stored row, and no `match.refresh` of the vacancy created under the rule set in force that
 * succeeded. The pool counter carries no rule set of its own, so the job history decides; a row of another rule set
 * may already be gone (a candidate's recalculation removes its rows) while the counter still counts it.
 */
async function vacancyPage(executor: Executor, basis: RulesetBasis, after: string | null): Promise<Page> {
	const rows = await executor.execute<{
		id: string;
		revision: string;
		processed: boolean;
		pending: boolean;
		reconciled: boolean;
	}>(sql`
		with batch as (
			select v.id, v.revision
			from vacancies v
			where (v.pool_count is not null or exists (select 1 from match_scores m where m.vacancy_id = v.id))
				${after === null ? sql`` : sql`and v.id > ${after}::uuid`}
			order by v.id
			limit ${BATCH_SIZE}
		),
		keyed as (
			select b.id, b.revision, ${VACANCY_KEY_PREFIX} || b.id::text as dedup_key, ${sinceOf(basis)} as since
			from batch b
		),
		${HISTORY}
		select k.id, k.revision::text as revision,
			h.succeeded_revision is not null as processed,
			coalesce(h.pending, false) as pending,
			coalesce(h.reconciled, false) as reconciled
		from keyed k
		left join history h on h.dedup_key = k.dedup_key
		order by k.id
	`);
	const due: DueDerivation[] = [];
	for (const row of rows) {
		if (!row.processed && !row.pending && !row.reconciled) {
			due.push({ scope: 'vacancy', vacancyId: row.id, revision: Number(row.revision) });
		}
	}
	return { due, last: rows.at(-1)?.id ?? null };
}

interface ReconcileScan {
	due: DueDerivation[];
	/** More derivations were due than one run enqueues. */
	capped: boolean;
}

/**
 * Every derivation due now, page by page, up to the limit of one run: the pools of vacancies first — a candidate's
 * recalculation recounts only the pools it enters or leaves — then the candidates.
 */
async function findDueDerivations(
	executor: Executor,
	signal: AbortSignal = new AbortController().signal
): Promise<ReconcileScan> {
	const bases = await loadBases(executor);
	const due: DueDerivation[] = [];
	const scan = async (page: (after: string | null) => Promise<Page>): Promise<boolean> => {
		let after: string | null = null;
		for (;;) {
			signal.throwIfAborted();
			const next = await page(after);
			due.push(...next.due);
			if (due.length > MAX_ENQUEUED_PER_RUN) return true;
			if (next.last === null) return false;
			after = next.last;
		}
	};
	const match = bases.match;
	const capped =
		(match !== null && (await scan((after) => vacancyPage(executor, match, after)))) ||
		(await scan((after) => candidatePage(executor, bases, after)));
	return capped ? { due: due.slice(0, MAX_ENQUEUED_PER_RUN), capped } : { due, capped };
}

/** Enqueues the found derivations at the revision they lag behind; one already waiting absorbs its duplicate. */
async function enqueueDueDerivations(tx: Transaction, due: readonly DueDerivation[]): Promise<number> {
	let joined = 0;
	for (const item of due) {
		const options = { inputVersion: String(item.revision), createdBy: CREATOR };
		let result;
		if (item.scope === 'vacancy') {
			result = await enqueueJob(tx, 'match.refresh', { scope: 'vacancy', vacancy_id: item.vacancyId }, options);
		} else if (item.type === 'match.refresh') {
			result = await enqueueJob(tx, item.type, { scope: 'candidate', candidate_id: item.candidateId }, options);
		} else {
			result = await enqueueJob(tx, item.type, { candidate_id: item.candidateId }, options);
		}
		if (result.joined) joined++;
	}
	return joined;
}

/** Handler of `derivations.reconcile` for the job registry. */
export const derivationsReconcile: JobHandler<'derivations.reconcile'> = defineHandler({
	type: 'derivations.reconcile',
	concurrency: 1,
	run: async ({ job, db, signal }) => {
		const scan = await findDueDerivations(db, signal);
		let joined = 0;
		const count = (type: ReconciledType) =>
			scan.due.filter((item) => item.scope === 'candidate' && item.type === type).length;
		return {
			// The period names no input: whatever lags at the moment of reading is due, and a job that appeared meanwhile
			// absorbs the enqueued one.
			isCurrent: () => Promise.resolve(true),
			write: async (tx) => {
				joined = await enqueueDueDerivations(tx, scan.due);
				// The jobs just enqueued are pending for the continuation, so it finds the next derivations due. It waits
				// under the same key until this run finishes.
				if (scan.capped) {
					await enqueueJob(tx, 'derivations.reconcile', job.payload, {
						inputVersion: job.inputVersion,
						createdBy: CREATOR
					});
				}
			},
			describe: () => ({
				evidence: count('evidence.compute'),
				embed: count('profile.embed'),
				match: count('match.refresh'),
				vacancies: scan.due.filter((item) => item.scope === 'vacancy').length,
				joined,
				capped: scan.capped
			})
		};
	}
});
