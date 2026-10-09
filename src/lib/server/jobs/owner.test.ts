// The owned line of the queue (insert.ts, queue.ts): which jobs a worker captures and which owner an enqueue gives.
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { jobOwnerFor, withJobOwner } from './insert';
import { ownedBy } from './queue';

const dialect = new PgDialect();

describe('owned line of the queue', () => {
	it('lets a worker of the stand capture only jobs without an owner, and an owner only its own', () => {
		expect(dialect.sqlToQuery(ownedBy(null))).toMatchObject({ sql: '"jobs"."owner" is null', params: [] });
		expect(dialect.sqlToQuery(ownedBy('demo_seed'))).toMatchObject({
			sql: '"jobs"."owner" = $1',
			params: ['demo_seed']
		});
	});

	it('gives the owner to the jobs of its types enqueued inside, timers and later turns included', async () => {
		expect(jobOwnerFor('fsp.sync')).toBeNull();
		const seen = await withJobOwner('demo_seed', ['fsp.sync', 'match.refresh'], async () => {
			const later = await new Promise<ReturnType<typeof jobOwnerFor>>((resolve) => {
				setTimeout(() => {
					resolve(jobOwnerFor('match.refresh'));
				}, 1);
			});
			return { now: jobOwnerFor('fsp.sync'), later, otherType: jobOwnerFor('profile.embed') };
		});
		expect(seen).toEqual({ now: 'demo_seed', later: 'demo_seed', otherType: null });
		expect(jobOwnerFor('fsp.sync')).toBeNull();
	});
});
