// The quality panel words every metric the evaluation harness writes and nothing it does not: the keys are read from
// the committed reports of the harness (tools/eval/reports), the numbers of real runs, not from a list kept by hand.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { METRIC_GROUPS, METRICS } from '$lib/components/admin/model';
import { runMetricsSchema } from '$lib/server/admin/quality';

const REPORTS = fileURLToPath(new URL('../../tools/eval/reports/', import.meta.url));

async function reportedKeys(): Promise<Set<string>> {
	const names = (await readdir(REPORTS)).filter((name) => name.endsWith('.json'));
	expect(names.length).toBeGreaterThan(0);
	const keys = new Set<string>();
	for (const name of names) {
		const summary = JSON.parse(await readFile(`${REPORTS}${name}`, 'utf8')) as { row: { metrics: unknown } };
		for (const key of Object.keys(runMetricsSchema.parse(summary.row.metrics))) keys.add(key);
	}
	return keys;
}

describe('quality panel labels', () => {
	it('words every metric key of the committed reports, and only those', async () => {
		const keys = await reportedKeys();
		expect([...keys].filter((key) => !(key in METRICS))).toEqual([]);
		expect(Object.keys(METRICS).filter((key) => !keys.has(key))).toEqual([]);
		const groups = new Set([...keys].map((key) => key.slice(0, key.indexOf('.'))));
		expect([...groups].filter((group) => !(group in METRIC_GROUPS))).toEqual([]);
	});
});
