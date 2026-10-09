import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbedConfig, ExtractConfig, RerankConfig } from '$lib/server/config';
import { ModelAdapter } from './adapter';
import { postJson } from './http';
import type { ModelMode } from './modes';
import type { SkillLexicon } from './quotes';
import { RESUME_EXTRACT_JSON_SCHEMA } from './resume-extract';
import { fail, ok, type ModelOperation, type ModelResult } from './result';
import type { EmbeddingSpace } from './spaces';

vi.mock('./http', () => ({ postJson: vi.fn() }));
const post = vi.mocked(postJson);

const breaker = { failures: 2, cooldownMs: 30_000 };

const extractConfig: ExtractConfig = {
	baseUrl: 'http://extractor:8000/v1',
	runtime: 'vllm',
	model: 'extractor-7b',
	apiKey: null,
	timeoutMs: 2_000,
	interactiveTimeoutMs: 1_000,
	maxConcurrency: 2,
	breaker
};

const rerankConfig: RerankConfig = {
	baseUrl: 'http://reranker:8001/v1',
	model: 'reranker',
	apiKey: null,
	timeoutMs: 2_000,
	interactiveTimeoutMs: 1_000,
	topN: 10,
	truncateTokens: 1_024,
	breaker
};

const space: EmbeddingSpace = {
	id: 'space-1',
	modelName: 'embedder',
	modelRevision: 'r1',
	dimension: 2,
	queryPrefix: '',
	documentPrefix: '',
	normalization: 'none',
	status: 'active'
};

const embedConfig: EmbedConfig = {
	baseUrl: 'http://embedder:8080/v1',
	model: space.modelName,
	apiKey: null,
	spaceId: space.id,
	timeoutMs: 2_000,
	interactiveTimeoutMs: 1_000,
	batchSize: 8,
	breaker
};

function adapter(modes: Partial<Record<ModelOperation, ModelMode>> = {}): ModelAdapter {
	return new ModelAdapter({
		models: { extract: extractConfig, embed: embedConfig, rerank: rerankConfig },
		modes: { current: (operation) => Promise.resolve(ok(modes[operation] ?? 'on')) },
		spaces: (id) => Promise.resolve(id === space.id ? space : null)
	});
}

const documents = [{ id: 'a', text: 'Go' }];
const rerank = (models: ModelAdapter, docs = documents) => models.rerank({ query: 'go', documents: docs, topN: 5 });
const embed = (models: ModelAdapter) =>
	models.embed({ spaceId: space.id, inputs: [{ id: 'q', kind: 'query', text: 'go' }] });

const resumeLexicon: SkillLexicon = { aliasesOf: () => [] };
const RESUME_REQUEST = {
	input: { type: 'document_extraction' as const, id: 'extraction-1' },
	schemaVersion: 'resume-extract/v3' as const,
	taxonomyVersionId: 'taxonomy-1',
	blocks: [{ id: 'p1-b001', text: 'Backend-разработчик' }]
};
const extract = (models: ModelAdapter, priority?: 'interactive' | 'background') =>
	models.extract(RESUME_REQUEST, resumeLexicon, priority ? { priority } : {});
const emptyResumeAnswer = JSON.stringify({
	jobs: [],
	skills: [],
	responsibilities: [],
	education: [],
	languages: [],
	achievements: [],
	full_name: [],
	contacts: [],
	soft_skills: []
});

const reranked = ok({ results: [{ index: 0, relevance_score: 0.7 }] });
const embedded = ok({ data: [{ index: 0, embedding: [0.6, 0.8] }] });
const extracted = ok({
	model: 'extractor-7b',
	choices: [{ finish_reason: 'stop', message: { content: emptyResumeAnswer } }]
});
const timedOut = fail('timeout', 'deadline passed');

function cause(result: ModelResult<unknown>): unknown {
	return result.ok ? null : { code: result.error.code, cause: result.error.details?.cause };
}

beforeEach(() => {
	post.mockReset();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(0);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('model adapter breaker', () => {
	it('stops calling a reranker that keeps failing until the cooldown is over, and closes on an answer', async () => {
		const models = adapter();
		post.mockResolvedValue(timedOut);
		expect(cause(await rerank(models))).toEqual({ code: 'timeout', cause: undefined });
		expect(cause(await rerank(models))).toEqual({ code: 'timeout', cause: undefined });
		expect(post).toHaveBeenCalledTimes(2);

		// Open: answered at once, the runtime is not called.
		const cooling = await rerank(models);
		expect(cooling).toMatchObject({
			ok: false,
			error: { code: 'unavailable', retryable: true, details: { cause: 'cooling_down', retry_after_ms: 30_000 } }
		});
		vi.setSystemTime(29_999);
		expect(cause(await rerank(models))).toEqual({ code: 'unavailable', cause: 'cooling_down' });
		expect(post).toHaveBeenCalledTimes(2);

		// The cooldown is over: the runtime is called; one more failure opens the breaker again at once.
		vi.setSystemTime(30_000);
		expect(cause(await rerank(models))).toEqual({ code: 'timeout', cause: undefined });
		expect(post).toHaveBeenCalledTimes(3);
		expect(cause(await rerank(models))).toEqual({ code: 'unavailable', cause: 'cooling_down' });
		expect(post).toHaveBeenCalledTimes(3);

		// An answer closes it: failures count from zero again.
		vi.setSystemTime(60_000);
		post.mockResolvedValueOnce(reranked);
		expect((await rerank(models)).ok).toBe(true);
		post.mockResolvedValue(timedOut);
		await rerank(models);
		expect(cause(await rerank(models))).toEqual({ code: 'timeout', cause: undefined });
		expect(post).toHaveBeenCalledTimes(6);
	});

	it('tells the state without calling the runtime when asked to rerank nothing', async () => {
		const models = adapter();
		expect(await rerank(models, [])).toMatchObject({ ok: true, value: { scores: [] } });
		post.mockResolvedValue(fail('unavailable', 'connection refused'));
		await rerank(models);
		await rerank(models);
		expect(cause(await rerank(models, []))).toEqual({ code: 'unavailable', cause: 'cooling_down' });
		expect(post).toHaveBeenCalledTimes(2);

		// Switched off, the reranker says so whatever its breaker.
		expect(cause(await rerank(adapter({ rerank: 'off' }), []))).toEqual({ code: 'disabled', cause: undefined });
	});

	it('counts only a runtime that did not answer; a cancelled call says nothing about it', async () => {
		const models = adapter();
		post.mockResolvedValueOnce(timedOut);
		post.mockResolvedValueOnce(fail('cancelled', 'cancelled by the caller'));
		post.mockResolvedValueOnce(fail('rate_limited', '429'));
		post.mockResolvedValueOnce(fail('request_rejected', '401'));
		post.mockResolvedValueOnce(timedOut);
		post.mockResolvedValueOnce(ok({ results: 'not a list' }));
		post.mockResolvedValueOnce(timedOut);
		// timeout, cancelled (not counted), 429: two in a row.
		await rerank(models);
		await rerank(models);
		await rerank(models);
		expect(cause(await rerank(models))).toEqual({ code: 'unavailable', cause: 'cooling_down' });
		vi.setSystemTime(30_000);
		// A refusal and a malformed answer are answers: each closes the breaker.
		expect(cause(await rerank(models))).toEqual({ code: 'request_rejected', cause: undefined });
		await rerank(models);
		expect(cause(await rerank(models))).toEqual({ code: 'invalid_output', cause: undefined });
		expect(cause(await rerank(models))).toEqual({ code: 'timeout', cause: undefined });
		expect(post).toHaveBeenCalledTimes(7);
	});

	it('keeps a breaker per operation: a failing reranker leaves the embedder alone, and the embedder has its own', async () => {
		const models = adapter();
		post.mockImplementation((operation) => Promise.resolve(operation === 'rerank' ? timedOut : embedded));
		await rerank(models);
		await rerank(models);
		expect(cause(await rerank(models))).toEqual({ code: 'unavailable', cause: 'cooling_down' });
		expect(await embed(models)).toMatchObject({ ok: true, value: { vectors: [{ id: 'q', vector: [0.6, 0.8] }] } });

		post.mockResolvedValue(fail('unavailable', 'connection refused'));
		await embed(models);
		await embed(models);
		expect(cause(await embed(models))).toEqual({ code: 'unavailable', cause: 'cooling_down' });
		expect(post).toHaveBeenCalledTimes(5);
	});
});

describe('extract breaker', () => {
	it('stops calling a runtime that keeps failing until the cooldown is over, and closes on an answer', async () => {
		const models = adapter();
		post.mockResolvedValue(timedOut);
		expect(cause(await extract(models))).toEqual({ code: 'timeout', cause: undefined });
		expect(cause(await extract(models))).toEqual({ code: 'timeout', cause: undefined });
		expect(post).toHaveBeenCalledTimes(2);

		// Open: answered at once, without calling the runtime or waiting for a limiter slot.
		const cooling = await extract(models);
		expect(cooling).toMatchObject({
			ok: false,
			error: { code: 'unavailable', retryable: true, details: { cause: 'cooling_down', retry_after_ms: 30_000 } }
		});
		vi.setSystemTime(29_999);
		expect(cause(await extract(models))).toEqual({ code: 'unavailable', cause: 'cooling_down' });
		expect(post).toHaveBeenCalledTimes(2);

		// The cooldown is over: the runtime is called; one more failure opens the breaker again at once.
		vi.setSystemTime(30_000);
		expect(cause(await extract(models))).toEqual({ code: 'timeout', cause: undefined });
		expect(post).toHaveBeenCalledTimes(3);
		expect(cause(await extract(models))).toEqual({ code: 'unavailable', cause: 'cooling_down' });
		expect(post).toHaveBeenCalledTimes(3);

		// An answer closes it: failures count from zero again.
		vi.setSystemTime(60_000);
		post.mockResolvedValueOnce(extracted);
		expect((await extract(models)).ok).toBe(true);
		post.mockResolvedValue(timedOut);
		await extract(models);
		expect(cause(await extract(models))).toEqual({ code: 'timeout', cause: undefined });
		expect(post).toHaveBeenCalledTimes(6);
	});

	it('shares one breaker between an interactive call and a background one: both meet the same runtime', async () => {
		const models = adapter();
		post.mockResolvedValue(timedOut);
		await extract(models, 'background');
		await extract(models, 'background');
		expect(post).toHaveBeenCalledTimes(2);
		// A person's call meets the breaker a job already opened, answered at once instead of paying its own deadline.
		expect(cause(await extract(models, 'interactive'))).toEqual({ code: 'unavailable', cause: 'cooling_down' });
		expect(post).toHaveBeenCalledTimes(2);

		vi.setSystemTime(30_000);
		post.mockResolvedValueOnce(extracted);
		expect((await extract(models, 'interactive')).ok).toBe(true);
		// The interactive answer closed it: a background call is not held closed by it.
		post.mockResolvedValueOnce(extracted);
		expect((await extract(models, 'background')).ok).toBe(true);
	});

	it('keeps a breaker per operation: a failing extractor leaves embed and rerank alone', async () => {
		const models = adapter();
		post.mockResolvedValue(timedOut);
		await extract(models);
		await extract(models);
		expect(cause(await extract(models))).toEqual({ code: 'unavailable', cause: 'cooling_down' });

		post.mockResolvedValue(embedded);
		expect(await embed(models)).toMatchObject({ ok: true });
		post.mockResolvedValue(reranked);
		expect(await rerank(models)).toMatchObject({ ok: true });
	});
});

describe('extract runtime profiles', () => {
	const withExtract = (overrides: Partial<ExtractConfig>) =>
		new ModelAdapter({
			models: { extract: { ...extractConfig, ...overrides }, embed: null, rerank: null },
			modes: { current: () => Promise.resolve(ok('on')) },
			spaces: () => Promise.resolve(null)
		});

	/** The `extract` request body the adapter sent. */
	function sentBody(): Record<string, unknown> {
		const call = post.mock.calls[0];
		if (!call) throw new Error('nothing was sent');
		return call[3] as Record<string, unknown>;
	}

	function keysOf(node: unknown, keys = new Set<string>()): Set<string> {
		if (Array.isArray(node)) node.forEach((value) => keysOf(value, keys));
		else if (typeof node === 'object' && node !== null) {
			for (const [key, value] of Object.entries(node)) {
				keys.add(key);
				keysOf(value, keys);
			}
		}
		return keys;
	}

	it('names the model answers are kept by only while extract would call it', async () => {
		expect(await adapter().extractModelKey()).toBe('vllm:extractor-7b');
		expect(await adapter({ extract: 'off' }).extractModelKey()).toBeNull();
		expect(await withExtract({ runtime: 'api', apiKey: null }).extractModelKey()).toBeNull();
		expect(await withExtract({ runtime: 'api', apiKey: 'key' }).extractModelKey()).toBe('api:extractor-7b');
		const unreadable = new ModelAdapter({
			models: { extract: extractConfig, embed: null, rerank: null },
			modes: { current: () => Promise.resolve(fail('unavailable', 'mode store is unreadable')) },
			spaces: () => Promise.resolve(null)
		});
		expect(await unreadable.extractModelKey()).toBeNull();
	});

	it('an external runtime without its key is off and is not called', async () => {
		const result = await extract(withExtract({ runtime: 'api', apiKey: null }));
		expect(result).toMatchObject({ ok: false, error: { code: 'disabled', details: { reason: 'no_api_key' } } });
		expect(post).not.toHaveBeenCalled();
	});

	it('sends an external runtime only fields a strict gateway accepts, the schema in the prompt', async () => {
		post.mockResolvedValue(extracted);
		const result = await extract(withExtract({ runtime: 'api', apiKey: 'key' }));
		expect(result).toMatchObject({ ok: true, value: { model: { runtime: 'api', params: { max_tokens: 16_384 } } } });
		const body = sentBody();
		expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'response_format']);
		expect(body.max_tokens).toBe(16_384);
		expect(body.response_format).toEqual({ type: 'json_object' });
		const [system] = body.messages as { role: string; content: string }[];
		expect(system?.role).toBe('system');
		expect(system?.content).toContain(JSON.stringify(RESUME_EXTRACT_JSON_SCHEMA));
	});

	it('sends its own vLLM server temperature 0 and the context-sized output limit', async () => {
		post.mockResolvedValue(extracted);
		const result = await extract(withExtract({ runtime: 'vllm', apiKey: null }));
		expect(result).toMatchObject({
			ok: true,
			value: { model: { runtime: 'vllm', params: { temperature: 0, max_tokens: 8_192 } } }
		});
		const body = sentBody();
		expect(body.temperature).toBe(0);
		expect(body.max_tokens).toBe(8_192);
		expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
		expect(keysOf(body.response_format).has('maxItems')).toBe(true);
		const [system] = body.messages as { content: string }[];
		expect(system?.content).not.toContain('"maxItems"');
	});

	it('reads an answer whose usage counts reasoning tokens', async () => {
		post.mockResolvedValue(
			ok({
				id: 'chatcmpl-1',
				object: 'chat.completion',
				model: 'anthropic/claude-haiku-5-5',
				choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: emptyResumeAnswer } }],
				usage: {
					prompt_tokens: 2062,
					completion_tokens: 1362,
					total_tokens: 3424,
					completion_tokens_details: { reasoning_tokens: 1180 }
				}
			})
		);
		expect(await extract(withExtract({ runtime: 'api', apiKey: 'key' }))).toMatchObject({
			ok: true,
			value: { model: { modelId: 'anthropic/claude-haiku-5-5', runtime: 'api' }, attempts: 1 }
		});
	});
});
