import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter } from './limiter';

const never = new AbortController().signal;

describe('concurrency limiter', () => {
	it('holds calls above the capacity and serves interactive waiters first', async () => {
		const limiter = new ConcurrencyLimiter(1);
		const first = await limiter.acquire('background', never);
		const order: string[] = [];
		const background = limiter.acquire('background', never).then((release) => {
			order.push('background');
			return release;
		});
		const interactive = limiter.acquire('interactive', never).then((release) => {
			order.push('interactive');
			return release;
		});
		expect(limiter.waiting).toBe(2);
		first?.();
		(await interactive)?.();
		(await background)?.();
		expect(order).toEqual(['interactive', 'background']);
		expect(limiter.active).toBe(0);
	});

	it('lets an aborted waiter leave the queue without taking a slot', async () => {
		const limiter = new ConcurrencyLimiter(1);
		const held = await limiter.acquire('background', never);
		const controller = new AbortController();
		const waiting = limiter.acquire('interactive', controller.signal);
		controller.abort();
		expect(await waiting).toBeNull();
		expect(limiter.waiting).toBe(0);
		held?.();
		expect(limiter.active).toBe(0);
	});

	it('refuses a double release', async () => {
		const limiter = new ConcurrencyLimiter(2);
		const release = await limiter.acquire('background', never);
		release?.();
		expect(() => release?.()).toThrow(/twice/);
	});
});
