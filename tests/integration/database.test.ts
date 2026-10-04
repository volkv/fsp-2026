import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', async () => {
	const { inject } = await import('vitest');
	const { testEnvironment } = await import('../helpers/environment');
	return { env: testEnvironment({ DATABASE_URL: inject('databaseUrl'), REDIS_URL: inject('redisUrl') }) };
});

const { db, closeDb } = await import('$lib/server/db');
const { closeRedis } = await import('$lib/server/redis');
const { checkHealth } = await import('$lib/server/health');

/** Lowest pgvector release the project supports. */
const MIN_PGVECTOR_VERSION = '0.8.4';

function compareVersions(a: string, b: string): number {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return Math.sign(diff);
	}
	return 0;
}

const migrationsFolder = fileURLToPath(new URL('../../src/lib/server/db/migrations', import.meta.url));

beforeAll(async () => {
	await migrate(db(), { migrationsFolder });
});

afterAll(async () => {
	closeRedis();
	await closeDb();
});

describe('database', () => {
	it(`has pgvector ${MIN_PGVECTOR_VERSION} or newer enabled by migrations`, async () => {
		const rows = await db().execute<{ extversion: string }>(
			sql`select extversion from pg_extension where extname = 'vector'`
		);
		const [row, ...rest] = rows;
		if (!row || rest.length > 0) throw new Error(`expected one pgvector row, got ${rows.length}`);
		const version = row.extversion;
		expect(version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(
			compareVersions(version, MIN_PGVECTOR_VERSION),
			`pgvector ${version} is older than ${MIN_PGVECTOR_VERSION}`
		).toBeGreaterThanOrEqual(0);
	});

	it('stores vectors and finds the nearest one through an HNSW index', async () => {
		await db().transaction(async (tx) => {
			await tx.execute(sql`create temporary table probe (id int primary key, v vector(3)) on commit drop`);
			await tx.execute(sql`create index on probe using hnsw (v vector_cosine_ops)`);
			await tx.execute(sql`insert into probe values (1, '[1,0,0]'), (2, '[0,1,0]'), (3, '[0.9,0.1,0]')`);
			const nearest = await tx.execute<{ id: number; distance: number }>(
				sql`select id, (v <-> '[1,0,0]')::float8 as distance from probe order by v <=> '[1,0,0]' limit 2`
			);
			expect(nearest).toEqual([
				{ id: 1, distance: 0 },
				{ id: 3, distance: expect.any(Number) as number }
			]);
		});
	});
});

describe('health', () => {
	it('reports ok against real Postgres and Redis', async () => {
		const report = await checkHealth();
		expect(report.status).toBe('ok');
		expect(report.checks).toEqual({ database: 'up', redis: 'up' });
	});
});
