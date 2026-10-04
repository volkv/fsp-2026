import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from './timeout';

describe('withTimeout', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('passes through a value that arrives in time and clears its timer', async () => {
		await expect(withTimeout(Promise.resolve('PONG'), 1_000, 'redis')).resolves.toBe('PONG');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('passes through a rejection that arrives in time', async () => {
		const failure = new Error('refused');
		await expect(withTimeout(Promise.reject(failure), 1_000, 'redis')).rejects.toBe(failure);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('rejects naming the dependency once the wait runs out', async () => {
		const pending = withTimeout(new Promise<never>(() => {}), 1_000, 'redis');
		const outcome = expect(pending).rejects.toThrow('redis did not answer within 1000 ms');
		await vi.advanceTimersByTimeAsync(999);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await outcome;
		expect(vi.getTimerCount()).toBe(0);
	});
});
