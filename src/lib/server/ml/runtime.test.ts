import { describe, expect, it } from 'vitest';
import { lacksApiKey } from './runtime';

describe('runtime profiles', () => {
	it('requires a key only of an external runtime', () => {
		expect(lacksApiKey({ runtime: 'api', apiKey: null })).toBe(true);
		expect(lacksApiKey({ runtime: 'api', apiKey: 'key' })).toBe(false);
		expect(lacksApiKey({ runtime: 'vllm', apiKey: null })).toBe(false);
	});
});
