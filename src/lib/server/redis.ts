import { createClient } from 'redis';
import { config } from '$lib/server/config';
import { loggedError } from '$lib/server/db/errors';

export type Redis = ReturnType<typeof createRedis>;

let client: Redis | undefined;
let connecting: Promise<Redis> | undefined;

function createRedis() {
	const created = createClient({
		url: config().redisUrl,
		// Fail commands immediately while disconnected instead of queueing them.
		disableOfflineQueue: true,
		socket: {
			connectTimeout: 5_000,
			reconnectStrategy: (retries) => Math.min(retries * 200, 5_000)
		}
	});
	created.on('error', (error: unknown) => {
		console.error('[redis] client error', loggedError(error));
	});
	return created;
}

/**
 * Connected Redis client, created on first use. While Redis is unreachable the client keeps reconnecting
 * and the returned promise stays pending; callers bound the wait themselves.
 */
export function redis(): Promise<Redis> {
	if (!connecting) {
		const created = createRedis();
		client = created;
		connecting = created.connect().then(
			() => created,
			(error: unknown) => {
				if (client === created) {
					client = undefined;
					connecting = undefined;
				}
				throw error;
			}
		);
	}
	return connecting;
}

/** Closes the client, including one that is still connecting, so that it does not keep the process alive. */
export function closeRedis(): void {
	const current = client;
	client = undefined;
	connecting = undefined;
	if (current?.isOpen) current.destroy();
}
