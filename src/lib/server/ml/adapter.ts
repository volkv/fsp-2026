// The model adapter (docs/contracts.md, section 3): the only way the product calls `extract`, `embed` and `rerank`.
// Each operation has its own runtime address, timeout and failure; one failing operation does not affect the others,
// and no failure is ever answered with a made-up result.
import { z } from 'zod';
import type { BreakerConfig, EmbedConfig, ExtractConfig, RerankConfig } from '$lib/server/config';
import type { CheckedItems, PreparedExtract, Rejected } from './extract-common';
import { postJson, type CallControl, type Endpoint } from './http';
import { ConcurrencyLimiter, type CallPriority } from './limiter';
import type { ModelMode } from './modes';
import { extractRetryMessage, extractUserMessage } from './prompts';
import type { SkillLexicon } from './quotes';
import { fail, ok, type ModelError, type ModelErrorCode, type ModelOperation, type ModelResult } from './result';
import { prepareResumeExtract, type ResumeItem } from './resume-extract';
import { l2Normalize, type EmbeddingSpace, type SpaceLookup } from './spaces';
import { prepareVacancyExtract, type VacancyItem, type VacancyLexicon } from './vacancy-extract';

export interface CallOptions {
	/**
	 * `interactive` — a person waits for the answer: a short deadline that includes waiting for a free slot, and
	 * precedence over background calls. `background` — a job: the configured timeout for every request. Default.
	 */
	priority?: CallPriority;
	signal?: AbortSignal;
}

/** Each `extract` schema: what it reads, which taxonomy keys it needs, what it returns. */
export interface ExtractSchemas {
	/** A resume: blocks of `document_extractions`. */
	'resume-extract/v2': { input: { type: 'document_extraction'; id: string }; lexicon: SkillLexicon; item: ResumeItem };
	/** Vacancy text pasted by an employer: paragraphs of the text. */
	'vacancy-extract/v2': {
		input: { type: 'vacancy'; id: string; revision: number };
		lexicon: VacancyLexicon;
		item: VacancyItem;
	};
}

export type ExtractSchemaVersion = keyof ExtractSchemas;

export interface ExtractRequest<V extends ExtractSchemaVersion> {
	input: ExtractSchemas[V]['input'];
	schemaVersion: V;
	taxonomyVersionId: string;
	/** Blocks of the document; the model sees them with their ids. */
	blocks: readonly { id: string; text: string }[];
}

export interface ModelInfo {
	modelId: string;
	modelRevision: string | null;
	params: Record<string, unknown>;
}

export interface ExtractResponse<I> {
	model: ModelInfo;
	/** Items that passed every check. */
	items: I[];
	rejected: Rejected[];
	/** 1, or 2 when the first answer failed the schema. */
	attempts: number;
	latencyMs: number;
}

export interface EmbedRequest {
	/** Must equal `EMBED_SPACE_ID`. */
	spaceId: string;
	inputs: readonly { id: string; kind: 'query' | 'document'; text: string }[];
}

export interface EmbedResponse {
	spaceId: string;
	vectors: { id: string; vector: number[] }[];
	latencyMs: number;
}

export interface RerankRequest {
	query: string;
	documents: readonly { id: string; text: string }[];
	topN: number;
}

export interface RerankResponse {
	model: { modelId: string };
	/** Highest score first. */
	scores: { id: string; score: number }[];
	latencyMs: number;
}

export interface ModelAdapterDeps {
	models: { extract: ExtractConfig | null; embed: EmbedConfig | null; rerank: RerankConfig | null };
	modes: { current(operation: ModelOperation): Promise<ModelResult<ModelMode>> };
	spaces: SpaceLookup;
}

/** Sampling of `extract`: extraction must be reproducible, not creative. */
const EXTRACT_PARAMS = { temperature: 0, max_tokens: 8_192 } as const;

const extractBlocks = z
	.array(z.object({ id: z.string().min(1), text: z.string() }))
	.min(1)
	.refine((blocks) => new Set(blocks.map((block) => block.id)).size === blocks.length, 'block ids must be unique');

const extractRequestSchema = z.discriminatedUnion('schemaVersion', [
	z.object({
		schemaVersion: z.literal('resume-extract/v2'),
		input: z.object({ type: z.literal('document_extraction'), id: z.string().min(1) }),
		taxonomyVersionId: z.string().min(1),
		blocks: extractBlocks
	}),
	z.object({
		schemaVersion: z.literal('vacancy-extract/v2'),
		input: z.object({ type: z.literal('vacancy'), id: z.string().min(1), revision: z.int().nonnegative() }),
		taxonomyVersionId: z.string().min(1),
		blocks: extractBlocks
	})
]);

function prepareExtract<V extends ExtractSchemaVersion>(
	version: V,
	lexicon: ExtractSchemas[V]['lexicon']
): PreparedExtract<ExtractSchemas[V]['item']> {
	// The request schema ties the version to its lexicon type; TypeScript cannot follow that through the switch.
	switch (version) {
		case 'resume-extract/v2':
			return prepareResumeExtract(lexicon);
		case 'vacancy-extract/v2':
			return prepareVacancyExtract(lexicon as VacancyLexicon);
	}
	throw new Error(`unknown extract schema ${String(version)}`);
}

const embedRequestSchema = z.object({
	spaceId: z.string().min(1),
	inputs: z
		.array(z.object({ id: z.string().min(1), kind: z.enum(['query', 'document']), text: z.string().min(1) }))
		.min(1)
});

const rerankRequestSchema = z.object({
	query: z.string().min(1),
	documents: z.array(z.object({ id: z.string().min(1), text: z.string() })),
	topN: z.int().positive()
});

const chatCompletionSchema = z.object({
	model: z.string().optional(),
	choices: z
		.array(
			z.object({
				finish_reason: z.string().nullish(),
				message: z.object({ content: z.string().nullish() })
			})
		)
		.min(1)
});

const embeddingsSchema = z.object({
	data: z.array(z.object({ index: z.int().nonnegative(), embedding: z.array(z.number()) }))
});

const rerankSchema = z.object({
	model: z.string().optional(),
	results: z.array(z.object({ index: z.int().nonnegative(), relevance_score: z.number() }))
});

/**
 * The answer to one `extract` attempt: checked items, a broken answer with the problem in words the model can act on
 * in its retry, or a failure no retry can fix.
 */
type AttemptOutcome<I> =
	| { kind: 'checked'; checked: CheckedItems<I>; modelId: string | null }
	| { kind: 'broken'; problem: string }
	| { kind: 'failed'; failure: { ok: false; error: ModelError } };

function readExtractAnswer<I>(
	body: unknown,
	prepared: PreparedExtract<I>,
	blocks: readonly { id: string; text: string }[]
): AttemptOutcome<I> {
	const completion = chatCompletionSchema.safeParse(body);
	if (!completion.success) return { kind: 'broken', problem: 'the response is not a chat completion' };
	const [choice] = completion.data.choices;
	// The runtime stopped the generation itself (it is shutting down): the cut answer says nothing about the model, and a
	// retry would meet a runtime that is going away.
	if (choice?.finish_reason === 'abort') {
		return {
			kind: 'failed',
			failure: fail('unavailable', 'extract: the runtime aborted the generation', { cause: 'aborted' })
		};
	}
	// The answer does not fit the output limit: the document yields more facts than one answer holds. A retry with the
	// same limit at temperature 0 is cut at the same place.
	if (choice?.finish_reason === 'length') {
		return {
			kind: 'failed',
			failure: fail('context_too_long', 'extract: the answer was cut off by the output token limit', {
				limit: 'output',
				max_tokens: EXTRACT_PARAMS.max_tokens
			})
		};
	}
	const content = choice?.message.content;
	if (!content) return { kind: 'broken', problem: 'the answer is empty' };
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch {
		return { kind: 'broken', problem: 'the answer is not valid JSON' };
	}
	const answer = prepared.check(json, blocks);
	if (!answer.ok) return { kind: 'broken', problem: answer.problem };
	return { kind: 'checked', checked: answer.checked, modelId: completion.data.model ?? null };
}

/** Failures that say the runtime did not answer. Any answer, even a wrong one, says it is there. */
const RUNTIME_DOWN: ReadonlySet<ModelErrorCode> = new Set(['unavailable', 'timeout', 'rate_limited']);

/**
 * The circuit breaker of one operation. After `failures` calls in a row whose runtime did not answer, the operation
 * answers `unavailable` (`cause: cooling_down`) for `cooldownMs` without calling the runtime: a runtime that hangs
 * costs one deadline, not one per request. The first call after the cooldown goes to the runtime; if it fails too, the
 * breaker opens again at once, and an answer closes it. A call the caller cancelled says nothing about the runtime.
 */
class Breaker {
	readonly #settings: BreakerConfig;
	#failures = 0;
	#openUntil = 0;

	constructor(settings: BreakerConfig) {
		this.#settings = settings;
	}

	/** What the operation answers instead of calling the runtime, or `null` when the runtime is called. */
	refusal(operation: ModelOperation, now: number): { ok: false; error: ModelError } | null {
		const left = this.#openUntil - now;
		if (left <= 0) return null;
		return fail('unavailable', `${operation}: the runtime failed ${this.#failures} times in a row, not called`, {
			cause: 'cooling_down',
			retry_after_ms: left
		});
	}

	record(result: ModelResult<unknown>, now: number): void {
		if (result.ok) {
			this.#failures = 0;
		} else if (RUNTIME_DOWN.has(result.error.code)) {
			this.#failures++;
			if (this.#failures >= this.#settings.failures) this.#openUntil = now + this.#settings.cooldownMs;
		} else if (result.error.code !== 'cancelled') {
			this.#failures = 0;
		}
	}
}

export class ModelAdapter {
	readonly #deps: ModelAdapterDeps;
	readonly #extractLimiter: ConcurrencyLimiter | null;
	readonly #extractBreaker: Breaker | null;
	readonly #embedBreaker: Breaker | null;
	readonly #rerankBreaker: Breaker | null;

	constructor(deps: ModelAdapterDeps) {
		this.#deps = deps;
		const { extract, embed, rerank } = deps.models;
		this.#extractLimiter = extract ? new ConcurrencyLimiter(extract.maxConcurrency) : null;
		this.#extractBreaker = extract ? new Breaker(extract.breaker) : null;
		this.#embedBreaker = embed ? new Breaker(embed.breaker) : null;
		this.#rerankBreaker = rerank ? new Breaker(rerank.breaker) : null;
	}

	/**
	 * One breaker per operation, shared by an interactive call and a background one: it is the runtime behind
	 * `*_BASE_URL` that is down or answering, not one caller's view of it, so a job that meets a dead runtime opens the
	 * same breaker a person's call would meet next, and the person is answered `cooling_down` at once instead of paying
	 * a second deadline to learn what the breaker already knows — and the other way round.
	 */
	#breaker(operation: 'extract' | 'embed' | 'rerank'): Breaker {
		const breaker =
			operation === 'extract' ? this.#extractBreaker : operation === 'embed' ? this.#embedBreaker : this.#rerankBreaker;
		if (!breaker) throw new Error(`${operation} breaker is missing for a configured operation`);
		return breaker;
	}

	/** One request to the runtime of an operation behind its breaker, which counts the outcome. */
	async #post(
		operation: 'extract' | 'embed' | 'rerank',
		endpoint: Endpoint,
		path: string,
		payload: unknown,
		control: CallControl
	): Promise<ModelResult<unknown>> {
		const response = await postJson(operation, endpoint, path, payload, control);
		this.#breaker(operation).record(response, Date.now());
		return response;
	}

	/** The configuration of the operation, or `disabled` when it is not configured or switched off. */
	async #gate<T>(operation: ModelOperation, settings: T | null): Promise<ModelResult<T>> {
		if (!settings) return fail('disabled', `${operation}: not configured`, { reason: 'not_configured' });
		const mode = await this.#deps.modes.current(operation);
		if (!mode.ok) return mode;
		if (mode.value === 'off') {
			return fail('disabled', `${operation}: switched off by an administrator`, { reason: 'switched_off' });
		}
		return ok(settings);
	}

	#timeout(settings: { timeoutMs: number; interactiveTimeoutMs: number }, priority: CallPriority): number {
		return priority === 'background' ? settings.timeoutMs : settings.interactiveTimeoutMs;
	}

	/**
	 * Deadline of the next request: an interactive call shares one deadline from its start; a background call gives
	 * every request the full timeout.
	 */
	#control(callDeadline: number, timeoutMs: number, priority: CallPriority, signal?: AbortSignal): CallControl {
		const deadline = priority === 'interactive' ? callDeadline : Date.now() + timeoutMs;
		return signal ? { deadline, signal } : { deadline };
	}

	async extract<V extends ExtractSchemaVersion>(
		request: ExtractRequest<V>,
		lexicon: ExtractSchemas[V]['lexicon'],
		options: CallOptions = {}
	): Promise<ModelResult<ExtractResponse<ExtractSchemas[V]['item']>>> {
		extractRequestSchema.parse(request);
		const prepared = prepareExtract(request.schemaVersion, lexicon);
		const gate = await this.#gate('extract', this.#deps.models.extract);
		if (!gate.ok) return gate;
		const settings = gate.value;
		const started = Date.now();
		// Checked before the limiter: a breaker already open must not make a new call wait for a slot the runtime will
		// not fill either, interactive or background.
		const cooling = this.#breaker('extract').refusal('extract', started);
		if (cooling) return cooling;
		const priority = options.priority ?? 'background';
		const timeoutMs = this.#timeout(settings, priority);
		const callDeadline = started + timeoutMs;

		const limiter = this.#extractLimiter;
		if (!limiter) throw new Error('extract limiter is missing for a configured operation');
		const waitSignals = [
			options.signal,
			priority === 'interactive' ? AbortSignal.timeout(timeoutMs) : undefined
		].filter((signal): signal is AbortSignal => signal !== undefined);
		const release = await limiter.acquire(priority, AbortSignal.any(waitSignals));
		if (!release) {
			return options.signal?.aborted
				? fail('cancelled', 'extract: cancelled by the caller')
				: fail('timeout', 'extract: no free runtime slot in time');
		}
		try {
			const endpoint: Endpoint = { baseUrl: settings.baseUrl, apiKey: settings.apiKey };
			const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
				{ role: 'system', content: prepared.systemPrompt },
				{ role: 'user', content: extractUserMessage(request.blocks) }
			];
			for (let attempt = 1; attempt <= 2; attempt++) {
				const response = await this.#post(
					'extract',
					endpoint,
					'chat/completions',
					{
						model: settings.model,
						messages,
						...EXTRACT_PARAMS,
						response_format: {
							type: 'json_schema',
							json_schema: { name: prepared.schemaName, strict: true, schema: prepared.jsonSchema }
						}
					},
					this.#control(callDeadline, timeoutMs, priority, options.signal)
				);
				if (!response.ok) return response;
				const answer = readExtractAnswer(response.value, prepared, request.blocks);
				if (answer.kind === 'failed') return answer.failure;
				if (answer.kind === 'checked') {
					return ok({
						model: { modelId: answer.modelId ?? settings.model, modelRevision: null, params: { ...EXTRACT_PARAMS } },
						items: answer.checked.items,
						rejected: answer.checked.rejected,
						attempts: attempt,
						latencyMs: Date.now() - started
					});
				}
				if (attempt === 2) {
					return fail('invalid_output', 'extract: the answer failed the schema twice', { problem: answer.problem });
				}
				const previous = chatCompletionSchema.safeParse(response.value);
				messages.push(
					{ role: 'assistant', content: previous.success ? (previous.data.choices[0]?.message.content ?? '') : '' },
					{ role: 'user', content: extractRetryMessage(answer.problem) }
				);
			}
			throw new Error('unreachable: extract attempts exhausted without a result');
		} finally {
			release();
		}
	}

	async embed(request: EmbedRequest, options: CallOptions = {}): Promise<ModelResult<EmbedResponse>> {
		embedRequestSchema.parse(request);
		const gate = await this.#gate('embed', this.#deps.models.embed);
		if (!gate.ok) return gate;
		const settings = gate.value;
		if (request.spaceId !== settings.spaceId) {
			return fail('space_mismatch', 'embed: the requested space is not the configured one', {
				requested: request.spaceId,
				configured: settings.spaceId
			});
		}
		const space = await this.#space(request.spaceId);
		if (!space.ok) return space;
		if (space.value.modelName !== settings.model) {
			return fail('space_mismatch', 'embed: the configured model does not produce this space', {
				space_id: request.spaceId
			});
		}

		const cooling = this.#breaker('embed').refusal('embed', Date.now());
		if (cooling) return cooling;

		const priority = options.priority ?? 'background';
		const started = Date.now();
		const timeoutMs = this.#timeout(settings, priority);
		const callDeadline = started + timeoutMs;
		const endpoint: Endpoint = { baseUrl: settings.baseUrl, apiKey: settings.apiKey };
		const vectors: EmbedResponse['vectors'] = [];

		for (let from = 0; from < request.inputs.length; from += settings.batchSize) {
			const batch = request.inputs.slice(from, from + settings.batchSize);
			const response = await this.#post(
				'embed',
				endpoint,
				'embeddings',
				{
					model: settings.model,
					encoding_format: 'float',
					input: batch.map(
						(input) => (input.kind === 'query' ? space.value.queryPrefix : space.value.documentPrefix) + input.text
					)
				},
				this.#control(callDeadline, timeoutMs, priority, options.signal)
			);
			if (!response.ok) return response;
			const batchVectors = readEmbeddings(response.value, batch.length, space.value);
			if (!batchVectors.ok) return batchVectors;
			batch.forEach((input, index) => {
				const vector = batchVectors.value[index];
				if (!vector) throw new Error('embedding batch lost a vector after validation');
				vectors.push({ id: input.id, vector });
			});
		}
		return ok({ spaceId: space.value.id, vectors, latencyMs: Date.now() - started });
	}

	async #space(spaceId: string): Promise<ModelResult<EmbeddingSpace>> {
		let space: EmbeddingSpace | null;
		try {
			space = await this.#deps.spaces(spaceId);
		} catch (error) {
			console.error('[ml] embedding space lookup failed', error);
			return fail('unavailable', 'embed: embedding space cannot be read', { cause: 'space_store' });
		}
		if (!space) return fail('space_mismatch', 'embed: the space is not registered', { space_id: spaceId });
		return ok(space);
	}

	/**
	 * A request without documents calls no runtime and tells what the reranker would answer right now: `disabled`,
	 * `unavailable` while its breaker is open, or an empty result.
	 */
	async rerank(request: RerankRequest, options: CallOptions = {}): Promise<ModelResult<RerankResponse>> {
		rerankRequestSchema.parse(request);
		const gate = await this.#gate('rerank', this.#deps.models.rerank);
		if (!gate.ok) return gate;
		const settings = gate.value;
		const started = Date.now();
		const cooling = this.#breaker('rerank').refusal('rerank', started);
		if (cooling) return cooling;
		if (request.documents.length === 0) {
			return ok({ model: { modelId: settings.model }, scores: [], latencyMs: 0 });
		}
		const priority = options.priority ?? 'background';
		const timeoutMs = this.#timeout(settings, priority);
		const topN = Math.min(request.topN, settings.topN, request.documents.length);
		const response = await this.#post(
			'rerank',
			{ baseUrl: settings.baseUrl, apiKey: settings.apiKey },
			'rerank',
			{
				model: settings.model,
				query: request.query,
				documents: request.documents.map((document) => document.text),
				top_n: topN,
				// A document longer than the reranker context would fail the whole request; it is cut instead.
				truncate_prompt_tokens: settings.truncateTokens,
				// Not every runtime honours it: the texts may come back, and the answer is read without them.
				return_documents: false
			},
			this.#control(started + timeoutMs, timeoutMs, priority, options.signal)
		);
		if (!response.ok) return response;
		const parsed = rerankSchema.safeParse(response.value);
		if (!parsed.success) return fail('invalid_output', 'rerank: the response is not a rerank result');
		const seen = new Set<number>();
		const scores: RerankResponse['scores'] = [];
		for (const result of parsed.data.results) {
			const document = request.documents[result.index];
			if (!document || seen.has(result.index) || !Number.isFinite(result.relevance_score)) {
				return fail('invalid_output', 'rerank: a result points outside the documents or repeats one');
			}
			seen.add(result.index);
			scores.push({ id: document.id, score: result.relevance_score });
		}
		if (scores.length > topN) return fail('invalid_output', 'rerank: more results than requested');
		scores.sort((a, b) => b.score - a.score);
		return ok({
			model: { modelId: parsed.data.model ?? settings.model },
			scores,
			latencyMs: Date.now() - started
		});
	}
}

function readEmbeddings(body: unknown, expected: number, space: EmbeddingSpace): ModelResult<number[][]> {
	const parsed = embeddingsSchema.safeParse(body);
	if (!parsed.success) return fail('invalid_output', 'embed: the response is not an embeddings list');
	if (parsed.data.data.length !== expected) {
		return fail('invalid_output', 'embed: the number of vectors differs from the number of inputs', {
			expected,
			received: parsed.data.data.length
		});
	}
	const vectors: number[][] = new Array<number[]>(expected);
	for (const entry of parsed.data.data) {
		if (entry.index >= expected || vectors[entry.index] !== undefined) {
			return fail('invalid_output', 'embed: vector indexes do not cover the inputs');
		}
		if (entry.embedding.length !== space.dimension) {
			return fail('space_mismatch', 'embed: vector dimension differs from the space', {
				space_id: space.id,
				expected: space.dimension,
				received: entry.embedding.length
			});
		}
		if (!entry.embedding.every(Number.isFinite)) return fail('invalid_output', 'embed: vector is not finite');
		if (space.normalization === 'l2') {
			const normalized = l2Normalize(entry.embedding);
			if (!normalized) return fail('invalid_output', 'embed: zero vector cannot be normalised');
			vectors[entry.index] = normalized;
		} else {
			vectors[entry.index] = entry.embedding;
		}
	}
	return ok(vectors);
}
