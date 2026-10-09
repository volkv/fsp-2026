// The one statement that puts a job into the queue (docs/domain.md, section 17.1): the row as the registry describes it,
// `ON CONFLICT (dedup_key) WHERE status = 'queued' DO UPDATE` joining a job already waiting under the same key, and the
// owner of the line of the queue it goes to (`withJobOwner`).
// Imported by plain Node (scripts/seed-taxonomy.ts through taxonomy/publish.ts): relative imports with extensions,
// erasable syntax only, no application aliases.
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
import type { JobOwner } from '../db/schema/jobs.ts';
import { uuidv7 } from '../ids.ts';
import { jobSpec, type JobPayload, type JobType } from './registry.ts';

export interface JobCreator {
	kind: 'user' | 'system' | 'webhook';
	id?: string;
}

export interface EnqueueOptions {
	/** Version of the input the job is enqueued for: a revision, a document id, a period. */
	inputVersion: string;
	createdBy: JobCreator;
	runAfter?: Date;
}

export interface EnqueueResult {
	jobId: string;
	/** The change joined a job already waiting under the same key. */
	joined: boolean;
}

interface OwnedLine {
	owner: JobOwner;
	types: ReadonlySet<JobType>;
}

const ownedLine = new AsyncLocalStorage<OwnedLine>();

/**
 * Runs `work` with the jobs of `types` it enqueues owned by `owner`: directly, through the product code it calls, and
 * through the handlers of a worker it starts, whose loops continue its asynchronous context. Such jobs are captured
 * only by a worker of the same owner (`claimJob`), never by the workers of the stand. A job of these types already
 * waiting under the same key passes to the owner when the enqueue joins it. Jobs of other types go to the stand.
 */
export function withJobOwner<T>(owner: JobOwner, types: readonly JobType[], work: () => Promise<T>): Promise<T> {
	return ownedLine.run({ owner, types: new Set(types) }, work);
}

/** The owner a job of `type` enqueued here gets; `null` — the stand's line. */
export function jobOwnerFor(type: JobType): JobOwner | null {
	const line = ownedLine.getStore();
	return line?.types.has(type) ? line.owner : null;
}

/** Runs one statement in the caller's transaction and returns its rows. */
export type RunStatement = (statement: SQL) => Promise<readonly Record<string, unknown>[]>;

const dialect = new PgDialect();

/** `RunStatement` over a postgres.js connection or transaction, for the code without the query builder's database. */
export function postgresStatements(client: postgres.Sql | postgres.TransactionSql): RunStatement {
	return async (statement) => {
		const query = dialect.sqlToQuery(statement);
		return client.unsafe(query.sql, query.params as postgres.ParameterOrJSON<never>[]);
	};
}

/**
 * Inserts the job or joins the one waiting under its key; atomic with the caller's change only inside its transaction.
 * One statement: the join locks the waiting job until the caller commits, so no worker captures it before the change;
 * a job a worker is capturing at that moment leaves `queued`, and the statement inserts a new one instead of joining.
 * An owner takes over the waiting job it joins; an enqueue of the stand leaves the job with its owner.
 */
export async function insertJob<T extends JobType>(
	run: RunStatement,
	type: T,
	payload: JobPayload<T>,
	options: EnqueueOptions
): Promise<EnqueueResult> {
	const spec = jobSpec(type);
	const parsed = spec.payload.parse(payload) as Record<string, unknown>;
	const dedupKey = spec.dedupKey(parsed);
	const runAfter = options.runAfter ? sql`${options.runAfter.toISOString()}::timestamptz` : sql`now()`;
	const owner = jobOwnerFor(type);
	const id = uuidv7();
	const [row] = await run(sql`
		insert into jobs (id, type, type_version, payload, input_version, dedup_key, status, priority, run_after, max_attempts, created_by, owner)
		values (
			${id}, ${type}, ${spec.typeVersion}, ${JSON.stringify(parsed)}::text::jsonb, ${options.inputVersion},
			${dedupKey}, 'queued', ${spec.priority}, ${runAfter}, ${spec.maxAttempts},
			${JSON.stringify(options.createdBy)}::text::jsonb, ${owner}
		)
		on conflict (dedup_key) where status = 'queued' do update set owner = coalesce(excluded.owner, jobs.owner)
		returning id
	`);
	if (!row) throw new Error(`job ${type} with key ${dedupKey} was neither inserted nor joined`);
	const jobId = idOf(row);
	return { jobId, joined: jobId !== id };
}

function idOf(row: Record<string, unknown>): string {
	if (typeof row.id !== 'string') throw new Error(`job id is not a string: ${typeof row.id}`);
	return row.id;
}
