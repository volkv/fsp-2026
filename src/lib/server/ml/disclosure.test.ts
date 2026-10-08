import { describe, expect, it } from 'vitest';
import type { ExtractConfig } from '$lib/server/config';
import { extractRoute } from './disclosure';
import { fail, ok } from './result';

const settings: ExtractConfig = {
	baseUrl: 'https://llmgate.example/v1',
	runtime: 'api',
	model: 'claude-sonnet:latest',
	apiKey: 'key',
	timeoutMs: 120_000,
	interactiveTimeoutMs: 30_000,
	maxConcurrency: 8,
	breaker: { failures: 3, cooldownMs: 30_000 }
};
const on = { current: () => Promise.resolve(ok('on' as const)) };

describe('where the text goes', () => {
	it('names the external model, the own one, or none — by the same rules the adapter follows', async () => {
		expect(await extractRoute(settings, on)).toEqual({ kind: 'external', model: 'claude-sonnet:latest' });
		expect(await extractRoute({ ...settings, runtime: 'vllm', apiKey: null, model: 'extract' }, on)).toEqual({
			kind: 'own',
			model: 'extract'
		});
		expect(await extractRoute({ ...settings, apiKey: null }, on)).toEqual({ kind: 'none' });
		expect(await extractRoute(null, on)).toEqual({ kind: 'none' });
		expect(await extractRoute(settings, { current: () => Promise.resolve(ok('off' as const)) })).toEqual({
			kind: 'none'
		});
		expect(await extractRoute(settings, { current: () => Promise.resolve(fail('unavailable', 'mode store')) })).toEqual(
			{ kind: 'none' }
		);
	});
});
