// `retention.sweep` (docs/domain.md, sections 10.4, 15.1, 18.1 and 19): keeps monthly partitions of the journal ahead
// of time and drops the months older than the journal retention period of the current `retention_policy`, one journal
// event per dropped month. Without a published policy nothing is dropped: the retention period is a product decision.
// Stored files past their own retention go as an account purge removes them (`$lib/server/erasure/purge`): the objects
// first, before the write transaction, then the rows of the objects removed — the files of attempt artifacts whose
// `retention_until` has passed, and the source files of FSP batches past `files.retention_until`. A failed removal of
// an object fails the attempt with every row in place; a repeat removes the same keys again. In the write transaction
// it also clears the content of expired attempt artifacts, removes the disclosures past `disclosure_retention_months`
// and applies `inactive_candidate_purge_days` to inactive profiles (`$lib/server/erasure/retention`).
import { and, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { clearExpiredArtifacts, expiredArtifactFiles, type ArtifactsCleared } from '$lib/server/assessments/retention';
import { recordAuditEvent } from '$lib/server/audit/record';
import { parsePolicyParams, type PolicyParams } from '$lib/server/consent/kinds';
import type { Executor, Transaction } from '$lib/server/db';
import {
	inactivityTerms,
	sweepDisclosures,
	sweepInactiveCandidates,
	type DisclosureSweep,
	type InactivitySweep
} from '$lib/server/erasure/retention';
import { files, productPolicies } from '$lib/server/db/schema';
import { objectStore, StorageError, type ObjectStore } from '$lib/server/storage/object-store';
import { defineHandler, JobFailure, type JobHandler } from './handler';

/** Months of the journal that exist ahead of the current one after every sweep. */
export const JOURNAL_MONTHS_AHEAD = 24;

const PARTITION_NAME = /^audit_events_(\d{4})_(\d{2})$/;

interface JournalPartition {
	name: string;
	/** First instant of the month, UTC. */
	from: Date;
	/** First instant of the next month, UTC: the exclusive upper bound. */
	to: Date;
}

/** The `retention_policy` in effect now by the database clock; `null` — none is published. */
export async function currentRetentionPolicy(executor: Executor): Promise<PolicyParams<'retention_policy'> | null> {
	const [row] = await executor
		.select({ params: productPolicies.params })
		.from(productPolicies)
		.where(and(eq(productPolicies.kind, 'retention_policy'), lte(productPolicies.effectiveFrom, sql`now()`)))
		.orderBy(desc(productPolicies.effectiveFrom), desc(productPolicies.version))
		.limit(1);
	return row ? parsePolicyParams('retention_policy', row.params) : null;
}

async function journalPartitions(tx: Transaction): Promise<JournalPartition[]> {
	const rows = await tx.execute<{ name: string }>(sql`
		select c.relname as name
		from pg_inherits i
		join pg_class c on c.oid = i.inhrelid
		where i.inhparent = 'audit_events'::regclass
	`);
	return rows.map(({ name }) => {
		const match = PARTITION_NAME.exec(name);
		if (!match) {
			// Every partition is created by audit_events_ensure_partitions; another one has bounds this job cannot trust.
			throw new JobFailure('unknown_journal_partition', `journal partition ${name} does not follow the naming`, {
				retryable: false
			});
		}
		const year = Number(match[1]);
		const month = Number(match[2]);
		return { name, from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 1)) };
	});
}

const isoDate = (value: Date) => value.toISOString().slice(0, 10);

export interface RetentionSweepSummary {
	partitionsCreated: number;
	partitionsDropped: number;
	/** `false` when no retention policy is in effect and expired data was not looked for. */
	policyInEffect: boolean;
}

/** What the periods of the policy other than the journal's removed or began; `null` — no policy is in effect. */
export interface PersonalDataSweep {
	disclosures: DisclosureSweep;
	/** `null` — the policy in effect is earlier than version 3 and states no notice: nobody is told or removed. */
	inactivity: InactivitySweep | null;
}

/** The disclosure and inactivity periods of the policy in effect, in the given transaction. */
export async function sweepPersonalData(
	tx: Transaction,
	requestId: string,
	at: Date
): Promise<PersonalDataSweep | null> {
	const policy = await currentRetentionPolicy(tx);
	if (!policy) return null;
	const inactivity = inactivityTerms(policy);
	return {
		disclosures: await sweepDisclosures(tx, policy, at),
		inactivity: inactivity === null ? null : await sweepInactiveCandidates(tx, inactivity, at, requestId)
	};
}

interface StoredFile {
	id: string;
	storageKey: string;
}

/** Source files of FSP batches whose `retention_until` ended before `today` (a date `YYYY-MM-DD`). */
export async function expiredBatchFiles(executor: Executor, today: string): Promise<StoredFile[]> {
	return executor
		.select({ id: files.id, storageKey: files.storageKey })
		.from(files)
		.where(and(eq(files.purpose, 'source_batch'), lt(files.retentionUntil, today)));
}

/** Removes the rows of the expired batch files whose objects are among `removedKeys`; returns how many. */
export async function removeExpiredBatchFiles(
	tx: Transaction,
	today: string,
	removedKeys: ReadonlySet<string>
): Promise<number> {
	const removable = (await expiredBatchFiles(tx, today)).filter((file) => removedKeys.has(file.storageKey));
	if (removable.length === 0) return 0;
	const removed = await tx
		.delete(files)
		.where(
			inArray(
				files.id,
				removable.map((file) => file.id)
			)
		)
		.returning({ id: files.id });
	return removed.length;
}

/** Removes the objects of the given keys; a storage failure fails the attempt, retryable as the storage says. */
async function removeObjects(store: ObjectStore, keys: readonly string[]): Promise<void> {
	for (const key of keys) {
		try {
			await store.delete(key);
		} catch (error) {
			if (!(error instanceof StorageError)) throw error;
			throw new JobFailure('storage_unavailable', 'an expired object could not be removed', {
				retryable: error.retryable
			});
		}
	}
}

/** One sweep in the given transaction; exported for the tests of its effects. */
export async function sweepJournal(tx: Transaction, requestId: string): Promise<RetentionSweepSummary> {
	const [ensured] = await tx.execute<{ created: number }>(
		sql`select audit_events_ensure_partitions(date_trunc('month', now())::date, ${JOURNAL_MONTHS_AHEAD + 1}) as created`
	);
	const partitionsCreated = ensured?.created ?? 0;
	const policy = await currentRetentionPolicy(tx);
	if (!policy) return { partitionsCreated, partitionsDropped: 0, policyInEffect: false };

	const [bound] = await tx.execute<{ cutoff: number }>(
		sql`select extract(epoch from now() - make_interval(months => ${policy.audit_retention_months}))::float8 as cutoff`
	);
	if (!bound) throw new Error('retention cutoff query returned no row');
	const cutoff = new Date(bound.cutoff * 1000);
	const expired = (await journalPartitions(tx))
		.filter((partition) => partition.to <= cutoff)
		.sort((a, b) => a.from.getTime() - b.from.getTime());
	for (const partition of expired) {
		await tx.execute(sql`drop table ${sql.identifier(partition.name)}`);
		await recordAuditEvent(tx, {
			action: 'audit.partition_dropped',
			outcome: 'success',
			actor: { kind: 'system' },
			requestId,
			details: { partition: partition.name, range_from: isoDate(partition.from), range_to: isoDate(partition.to) }
		});
	}
	return { partitionsCreated, partitionsDropped: expired.length, policyInEffect: true };
}

/** Today in UTC by the database clock, as `YYYY-MM-DD`: the day every `retention_until` is compared with. */
async function utcToday(executor: Executor): Promise<string> {
	const [row] = await executor.execute<{ today: string }>(
		sql`select to_char(now() at time zone 'UTC', 'YYYY-MM-DD') as today`
	);
	if (!row) throw new Error('current date query returned no row');
	return row.today;
}

export interface RetentionSweepDeps {
	store: ObjectStore;
}

/** The handler of `retention.sweep`; `deps` is asked only when there are expired objects to remove. */
export function createRetentionSweepHandler(deps: () => RetentionSweepDeps): JobHandler<'retention.sweep'> {
	return defineHandler({
		type: 'retention.sweep',
		concurrency: 1,
		run: async ({ db: database, requestId }) => {
			const today = await utcToday(database);
			const expired = [...(await expiredArtifactFiles(database, today)), ...(await expiredBatchFiles(database, today))];
			const keys = expired.map((file) => file.storageKey);
			if (keys.length > 0) await removeObjects(deps().store, keys);
			const removedKeys = new Set(keys);
			let summary: RetentionSweepSummary | undefined;
			let artifacts: ArtifactsCleared | undefined;
			let batchFilesRemoved: number | undefined;
			let personal: PersonalDataSweep | null = null;
			return {
				// The rows are read again inside the write transaction: an object that appeared after the removal above keeps
				// its row until the next sweep, and a row removed meanwhile is not counted.
				isCurrent: () => Promise.resolve(true),
				write: async (tx) => {
					summary = await sweepJournal(tx, requestId);
					artifacts = await clearExpiredArtifacts(tx, today, removedKeys);
					batchFilesRemoved = await removeExpiredBatchFiles(tx, today, removedKeys);
					personal = await sweepPersonalData(tx, requestId, new Date());
				},
				describe: () => ({
					partitions_created: summary?.partitionsCreated,
					partitions_dropped: summary?.partitionsDropped,
					retention_policy: summary?.policyInEffect,
					artifacts_cleared: artifacts?.artifacts,
					artifact_files_removed: artifacts?.files,
					batch_files_removed: batchFilesRemoved,
					disclosures_removed: personal?.disclosures.disclosuresRemoved,
					consent_events_removed: personal?.disclosures.consentEventsRemoved,
					inactivity_terms: personal === null ? undefined : personal.inactivity !== null,
					inactive_noticed: personal?.inactivity?.noticed,
					inactive_kept: personal?.inactivity?.kept,
					inactive_deleted: personal?.inactivity?.deleted
				})
			};
		}
	});
}

/** Handler of `retention.sweep` for the job registry. */
export const retentionSweep = createRetentionSweepHandler(() => ({ store: objectStore() }));
