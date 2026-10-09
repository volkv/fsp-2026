import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ExtractResponse, ModelAdapter } from '$lib/server/ml/adapter';
import { fail, ok } from '$lib/server/ml/result';
import type { VacancyItem, VacancyLexicon } from '$lib/server/ml/vacancy-extract';
import { extractPastedText, memoryTextParseCache, TEXT_PARSE_CACHE_WAIT_MS, type TextParseCache } from './text-extract';

const lexicon: VacancyLexicon = {
	aliasesOf: () => [],
	grades: ['junior', 'middle', 'senior'],
	terms: { work_format: ['remote'], employment_form: ['full'], contract_type: ['labor'] }
};

const input = {
	companyId: 'company-1',
	inputSha256: 'a'.repeat(64),
	inputId: 'vacancy-1',
	taxonomyVersionId: 'taxonomy-1',
	blocks: [{ id: 'p1', text: 'Senior Go-разработчик' }]
};

const answer: ExtractResponse<VacancyItem> = {
	model: { modelId: 'extractor', modelRevision: null, runtime: 'api', params: {} },
	items: [
		{
			kind: 'role_title',
			rawText: 'Senior Go-разработчик',
			polarity: null,
			modelPolarity: null,
			grade: null,
			value: null,
			salary: null,
			quote: { blockId: 'p1', start: 0, end: 21, text: 'Senior Go-разработчик' }
		}
	],
	rejected: [],
	attempts: 1,
	latencyMs: 40
};

/** A model switched on or off as the adapter's own `extractModelKey` and `extract` see it; counts its calls. */
function model() {
	const state = { on: true, calls: 0 };
	const models: Pick<ModelAdapter, 'extract' | 'extractModelKey'> = {
		extractModelKey: () => Promise.resolve(state.on ? 'api:extractor' : null),
		extract: () => {
			if (!state.on) return Promise.resolve(fail('disabled', 'extract: switched off', { reason: 'switched_off' }));
			state.calls++;
			return Promise.resolve(ok(answer) as Awaited<ReturnType<ModelAdapter['extract']>>);
		}
	};
	return { state, models };
}

/** The cache with every key it was asked for. */
function recording(cache: TextParseCache) {
	const keys: string[] = [];
	return {
		keys,
		cache: {
			read: (key: string) => {
				keys.push(key);
				return cache.read(key);
			},
			write: (key: string, value: string, ttl: number) => cache.write(key, value, ttl)
		} satisfies TextParseCache
	};
}

describe('the kept answer to a pasted text', () => {
	let warn: MockInstance<typeof console.warn>;
	beforeEach(() => {
		warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	});
	afterEach(() => {
		warn.mockRestore();
		vi.useRealTimers();
	});

	it('is given again without a call and says so, but not once the model is switched off', async () => {
		const { state, models } = model();
		const parseCache = memoryTextParseCache();
		const first = await extractPastedText({ models, parseCache }, input, lexicon);
		expect(first).toMatchObject({ ok: true, value: { origin: null } });
		const again = await extractPastedText({ models, parseCache }, input, lexicon);
		expect(again).toMatchObject({ ok: true, value: { origin: 'cached', items: answer.items } });
		expect(state.calls).toBe(1);

		state.on = false;
		const off = await extractPastedText({ models, parseCache }, input, lexicon);
		expect(off).toMatchObject({ ok: false, error: { code: 'disabled' } });
	});

	it('kept in another shape is a miss: the model is asked, the log says why without the text', async () => {
		const { state, models } = model();
		const { cache, keys } = recording(memoryTextParseCache());
		await extractPastedText({ models, parseCache: cache }, input, lexicon);
		const [key] = keys;
		if (!key) throw new Error('the cache was not read');

		for (const broken of ['{"items": [{"kind": "Senior Go-разработчик"}]}', 'Senior Go-разработчик']) {
			await cache.write(key, broken, 60);
			const result = await extractPastedText({ models, parseCache: cache }, input, lexicon);
			expect(result).toMatchObject({ ok: true, value: { origin: null } });
		}
		expect(state.calls).toBe(3);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(warn.mock.calls)).not.toContain('Senior');
	});

	it('the key carries the shape of the kept answer', async () => {
		const { models } = model();
		const { cache, keys } = recording(memoryTextParseCache());
		await extractPastedText({ models, parseCache: cache }, input, lexicon);
		expect(keys[0]).toMatch(/^text-parse:vacancy-extract\/v2:[0-9a-f]{12}:api%3Aextractor:taxonomy-1:company-1:a{64}$/);
	});

	it('a store that fails or hangs is a miss, said in the log, and the model is asked', async () => {
		const { state, models } = model();
		const failing: TextParseCache = {
			read: () => Promise.reject(new Error('connection lost')),
			write: () => Promise.reject(new Error('connection lost'))
		};
		expect(await extractPastedText({ models, parseCache: failing }, input, lexicon)).toMatchObject({ ok: true });
		expect(state.calls).toBe(1);
		expect(warn).toHaveBeenCalledTimes(2);

		vi.useFakeTimers();
		const hanging: TextParseCache = {
			read: () => new Promise(() => undefined),
			write: () => new Promise(() => undefined)
		};
		const pending = extractPastedText({ models, parseCache: hanging }, input, lexicon);
		await vi.advanceTimersByTimeAsync(TEXT_PARSE_CACHE_WAIT_MS * 2 + 1);
		expect(await pending).toMatchObject({ ok: true, value: { origin: null } });
		expect(state.calls).toBe(2);
	});
});
