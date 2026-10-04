// The one statement that puts a job into the queue (docs/domain.md, section 17.1): the row as the registry describes it,
// `ON CONFLICT (dedup_key) WHERE status = 'queued' DO NOTHING` joining a job already waiting under the same key.
// Imported by plain Node (scripts/seed-taxonomy.ts through taxonomy/publish.ts): relative imports with extensions,
// erasable syntax only, no application aliases.
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
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

/** Inserts the job or joins the one waiting under its key; atomic with the caller's change only inside its transaction. */
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
	const [created] = await run(sql`
		insert into jobs (id, type, type_version, payload, input_version, dedup_key, status, priority, run_after, max_attempts, created_by)
		values (
			${uuidv7()}, ${type}, ${spec.typeVersion}, ${JSON.stringify(parsed)}::text::jsonb, ${options.inputVersion},
			${dedupKey}, 'queued', ${spec.priority}, ${runAfter}, ${spec.maxAttempts},
			${JSON.stringify(options.createdBy)}::text::jsonb
		)
		on conflict (dedup_key) where status = 'queued' do nothing
		returning id
	`);
	if (created) return { jobId: idOf(created), joined: false };
	const [waiting] = await run(sql`select id from jobs where dedup_key = ${dedupKey} and status = 'queued'`);
	if (!waiting) throw new Error(`job ${type} with key ${dedupKey} conflicted but no waiting job was found`);
	return { jobId: idOf(waiting), joined: true };
}

function idOf(row: Record<string, unknown>): string {
	if (typeof row.id !== 'string') throw new Error(`job id is not a string: ${typeof row.id}`);
	return row.id;
}
