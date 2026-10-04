import { describe, expect, it } from 'vitest';
import { parseWorkerArgs } from './args';

describe('worker command line', () => {
	it('parses the enabled types, concurrency overrides and the state port', () => {
		expect(
			parseWorkerArgs([
				'--types',
				'retention.sweep, resume.parse',
				'--concurrency',
				'resume.parse=4',
				'--health-port',
				'3101',
				'--shutdown-grace-ms',
				'5000'
			])
		).toEqual({
			types: ['retention.sweep', 'resume.parse'],
			concurrency: { 'resume.parse': 4 },
			healthPort: 3101,
			shutdownGraceMs: 5000
		});
		expect(parseWorkerArgs(['--types=retention.sweep', '--no-health'])).toMatchObject({ healthPort: null });
	});

	it('requires an explicit list of types and refuses malformed values', () => {
		expect(() => parseWorkerArgs([])).toThrow(/--types is required/);
		expect(() => parseWorkerArgs(['--types', 'a', '--concurrency', 'a'])).toThrow(/<type>=<n>/);
		expect(() => parseWorkerArgs(['--types', 'a', '--concurrency', 'a=0'])).toThrow(/positive integer/);
		expect(() => parseWorkerArgs(['--types', 'a', '--concurrency', 'a=1', '--concurrency', 'a=2'])).toThrow(/twice/);
		expect(() => parseWorkerArgs(['--types', 'a', '--no-health', '--health-port', '1'])).toThrow(/exclude/);
		expect(() => parseWorkerArgs(['--types', 'a', '--unknown'])).toThrow();
	});
});
