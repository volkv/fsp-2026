// The configured FSP ID client; `null` when sign-in through FSP ID is not configured (FSP_ID_* empty).
import { withTimeout } from '$lib/server/async/timeout';
import { config } from '$lib/server/config';
import { redis } from '$lib/server/redis';
import { createFspIdClient, storeFailure, type FspIdClient, type FspIdResult } from './oidc';

/** How long a sign-in waits for Redis, which keeps the flow, before the browser is sent back with an explanation. */
const REDIS_WAIT_MS = 1_000;

let cached: FspIdClient | undefined;

export function fspIdConfigured(): boolean {
	return config().fspId !== null;
}

/**
 * The client over a connected flow store. While Redis is unreachable the connection stays pending (see `redis()`), so
 * the wait is bounded and a `store_unavailable` result is returned; the next request tries again.
 */
export async function fspIdClient(): Promise<FspIdResult<FspIdClient> | null> {
	const settings = config().fspId;
	if (!settings) return null;
	if (cached) return { ok: true, value: cached };
	let store;
	try {
		store = await withTimeout(redis(), REDIS_WAIT_MS, 'redis');
	} catch (error) {
		return storeFailure(error);
	}
	cached ??= createFspIdClient(settings, { redis: store, now: () => new Date() });
	return { ok: true, value: cached };
}
