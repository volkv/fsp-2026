import { describe, expect, it } from 'vitest';
import { lacksApiKey, requestSchema, RUNTIME_PROFILES } from './runtime';

const schema = {
	type: 'object',
	properties: {
		maxItems: { type: 'integer', minimum: 0 },
		skills: {
			maxItems: 80,
			type: 'array',
			items: { type: 'object', properties: { tags: { maxItems: 2, type: 'array' } } }
		}
	}
};

describe('runtime profiles', () => {
	it('drops the maxItems keyword for an external runtime and keeps a field of that name', () => {
		expect(requestSchema(RUNTIME_PROFILES.api, schema)).toEqual({
			type: 'object',
			properties: {
				maxItems: { type: 'integer', minimum: 0 },
				skills: { type: 'array', items: { type: 'object', properties: { tags: { type: 'array' } } } }
			}
		});
		expect(requestSchema(RUNTIME_PROFILES.vllm, schema)).toBe(schema);
	});

	it('requires a key only of an external runtime', () => {
		expect(lacksApiKey({ runtime: 'api', apiKey: null })).toBe(true);
		expect(lacksApiKey({ runtime: 'api', apiKey: 'key' })).toBe(false);
		expect(lacksApiKey({ runtime: 'vllm', apiKey: null })).toBe(false);
	});
});
