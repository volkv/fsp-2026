import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '$lib/server/config';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;
/** A transaction of `Database`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that runs queries: the database or an open transaction. */
export type Executor = Database | Transaction;

let client: postgres.Sql | undefined;
let database: Database | undefined;

/** Drizzle instance over a shared connection pool, created on first use. */
export function db(): Database {
	if (!database) {
		client = postgres(config().databaseUrl, { max: 10, connect_timeout: 5 });
		database = drizzle({ client, schema, casing: 'snake_case' });
	}
	return database;
}

export async function closeDb(): Promise<void> {
	const current = client;
	client = undefined;
	database = undefined;
	await current?.end({ timeout: 5 });
}
