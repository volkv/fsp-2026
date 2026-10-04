import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn<() => Promise<unknown>>();
const ping = vi.fn<() => Promise<string>>();

vi.mock('$lib/server/db', () => ({ db: () => ({ execute }) }));
vi.mock('$lib/server/redis', () => ({ redis: () => Promise.resolve({ ping }) }));

const { checkHealth } = await import('./health');

describe('checkHealth', () => {
	beforeEach(() => {
		execute.mockReset().mockResolvedValue([]);
		ping.mockReset().mockResolvedValue('PONG');
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('reports ok with build metadata when both dependencies answer', async () => {
		const report = await checkHealth();
		expect(report).toEqual({
			status: 'ok',
			version: __APP_VERSION__,
			commit: __APP_COMMIT__,
			checks: { database: 'up', redis: 'up' }
		});
	});

	it('reports degraded without exposing the failure', async () => {
		ping.mockRejectedValue(new Error('NOAUTH secret-token'));
		const report = await checkHealth();
		expect(report.status).toBe('degraded');
		expect(report.checks).toEqual({ database: 'up', redis: 'down' });
		expect(JSON.stringify(report)).not.toContain('secret-token');
		expect(console.error).toHaveBeenCalledOnce();
	});

	it('treats a hanging dependency as down after the probe timeout', async () => {
		vi.useFakeTimers();
		try {
			execute.mockReturnValue(new Promise(() => {}));
			const pending = checkHealth();
			await vi.advanceTimersByTimeAsync(2_000);
			const report = await pending;
			expect(report.checks.database).toBe('down');
		} finally {
			vi.useRealTimers();
		}
	});
});
