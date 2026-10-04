// Level of a failed attempt in the worker log: a routine retry (a busy parser answering «come back later») is a
// warning, so the error lines of a stand are the failures someone has to look at.
import { describe, expect, it, vi } from 'vitest';
import { JobFailure } from './handler';
import { createLogger, type LogLevel } from './log';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { logFailedAttempt } = await import('./worker');

function capture() {
	const lines: { level: LogLevel; entry: Record<string, unknown> }[] = [];
	const log = createLogger({}, (level, line) => {
		lines.push({ level, entry: JSON.parse(line) as Record<string, unknown> });
	});
	return { log, lines };
}

const busy = new JobFailure('docparse_busy', 'the parser is busy', { retryable: true, retryAfterSeconds: 10 });
const busyError = { code: busy.code, retryable: true, message: busy.message };

describe('failed attempt in the worker log', () => {
	it('is a warning for a retryable failure with attempts left', () => {
		const { log, lines } = capture();
		logFailedAttempt(log, { attempt: 1, maxAttempts: 5 }, busy, busyError);
		expect(lines).toEqual([
			{
				level: 'warn',
				entry: expect.objectContaining({
					msg: 'job attempt failed, it will be retried',
					code: 'docparse_busy',
					retryable: true,
					error_message: 'the parser is busy'
				}) as unknown
			}
		]);
	});

	it('is an error on the last attempt', () => {
		const { log, lines } = capture();
		logFailedAttempt(log, { attempt: 5, maxAttempts: 5 }, busy, busyError);
		expect(lines.map((line) => line.level)).toEqual(['error']);
		expect(lines[0]?.entry).toMatchObject({ msg: 'job attempt failed', code: 'docparse_busy' });
	});

	it('is an error for a permanent failure', () => {
		const { log, lines } = capture();
		const failure = new JobFailure('demo_mode_off', 'DEMO_MODE is not true', { retryable: false });
		logFailedAttempt(log, { attempt: 1, maxAttempts: 5 }, failure, {
			code: failure.code,
			retryable: false,
			message: failure.message
		});
		expect(lines.map((line) => line.level)).toEqual(['error']);
	});

	it('is an error for an unexpected error, retried or not', () => {
		const { log, lines } = capture();
		logFailedAttempt(log, { attempt: 1, maxAttempts: 5 }, new TypeError('x is undefined'), {
			code: 'unexpected_error',
			retryable: true,
			message: 'TypeError'
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ level: 'error', entry: { error_name: 'TypeError' } });
	});
});
