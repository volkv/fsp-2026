import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { inject } from 'vitest';
import type { Database } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../src/lib/server/db/migrations', import.meta.url));

export interface TestDatabase {
	url: string;
	db: Database;
	/** Raw client of the same database for statements the query builder does not express. */
	sql: postgres.Sql;
	drop(): Promise<void>;
}

/**
 * A fresh database in the shared test container with all migrations applied from scratch.
 * Every test file gets its own database, so files run in parallel without sharing rows.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
	const adminUrl = inject('databaseUrl');
	const name = `test_${randomBytes(6).toString('hex')}`;
	const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
	try {
		await admin.unsafe(`create database ${name}`);
	} finally {
		await admin.end({ timeout: 5 });
	}
	const url = new URL(adminUrl);
	url.pathname = `/${name}`;
	const client = postgres(url.toString(), { max: 4, onnotice: () => {} });
	const db = drizzle({ client, schema, casing: 'snake_case' });
	await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	return {
		url: url.toString(),
		db,
		sql: client,
		async drop() {
			await client.end({ timeout: 5 });
			const cleanup = postgres(adminUrl, { max: 1, onnotice: () => {} });
			try {
				await cleanup.unsafe(`drop database ${name} with (force)`);
			} finally {
				await cleanup.end({ timeout: 5 });
			}
		}
	};
}
