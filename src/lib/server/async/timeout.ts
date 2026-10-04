// A bounded wait for a dependency that may hang (a Redis connection stays pending while the server is unreachable).

/**
 * The value of `promise`, or a rejection naming `what` once `ms` pass first. The timer is cleared either way; the
 * promise itself is not cancelled.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`${what} did not answer within ${ms} ms`));
		}, ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		clearTimeout(timer);
	});
}
