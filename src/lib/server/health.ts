import { sql } from 'drizzle-orm';
import { withTimeout } from '$lib/server/async/timeout';
import { db } from '$lib/server/db';
import { redis } from '$lib/server/redis';

export type ProbeStatus = 'up' | 'down';

export interface HealthReport {
	status: 'ok' | 'degraded';
	version: string;
	commit: string;
	checks: {
		database: ProbeStatus;
		redis: ProbeStatus;
	};
}

const PROBE_TIMEOUT_MS = 2_000;

async function probe(name: string, check: () => Promise<unknown>): Promise<ProbeStatus> {
	try {
		await withTimeout(check(), PROBE_TIMEOUT_MS, name);
		return 'up';
	} catch (error) {
		// Details stay in the server log; the response only says the dependency is down.
		console.error(`[health] ${name} probe failed`, error);
		return 'down';
	}
}

export async function checkHealth(): Promise<HealthReport> {
	const [database, cache] = await Promise.all([
		probe('database', () => db().execute(sql`select 1`)),
		probe('redis', async () => (await redis()).ping())
	]);
	return {
		status: database === 'up' && cache === 'up' ? 'ok' : 'degraded',
		version: __APP_VERSION__,
		commit: __APP_COMMIT__,
		checks: { database, redis: cache }
	};
}
