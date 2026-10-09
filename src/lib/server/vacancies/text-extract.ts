// The model's reading of a pasted text — a vacancy (`from-text.ts`) or a hiring need (`needs/parse.ts`), both of the
// schema `vacancy-extract/v2` — kept by the hash of the text (`ml_results.input_sha256`). An employer who pastes the
// same text again, or asks for the parse again, gets the answer the model gave, and the model is not called: the
// spending of the gateway does not grow with repeats. An answer is kept per company, taxonomy version, schema and the
// configured model for a day: after the model is changed, the answers of the previous one are not given out, and while
// the model would not be called — switched off, no API key — none is given out either: the text is read by the rules,
// as the mode promises. Only an answer of the model is kept — a failed call is not, so the next parse asks the model
// again. The store is a convenience: an answer it cannot give in time, or one of another shape, is a miss, said in the
// log, and the model is asked.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withTimeout } from '$lib/server/async/timeout';
import { loggedError } from '$lib/server/db/errors';
import type { CallOptions, ExtractResponse, ModelAdapter, ModelInfo } from '$lib/server/ml/adapter';
import type { KeptOrigin } from '$lib/server/ml/envelope';
import type { RejectReason } from '$lib/server/ml/extract-common';
import { modelInfoSchema, vacancyOutputSchema } from '$lib/server/ml/extract-output';
import type { Block } from '$lib/server/ml/quotes';
import { ok, type ModelResult } from '$lib/server/ml/result';
import type { VacancyItem, VacancyLexicon } from '$lib/server/ml/vacancy-extract';
import type { Redis } from '$lib/server/redis';

/** Schema of a pasted text's parse; a draft is saved only from a parse of this schema. */
export const VACANCY_SCHEMA_VERSION = 'vacancy-extract/v2';

/** How long an answer of the model is kept. */
export const TEXT_PARSE_CACHE_SECONDS = 86_400;

/** How long the store of kept answers may take to answer before the answer counts as not kept. */
export const TEXT_PARSE_CACHE_WAIT_MS = 500;

/** What a parse records of the model's answer. */
export interface TextExtract {
	model: ModelInfo;
	items: VacancyItem[];
	rejectedReasons: RejectReason[];
	/** Time of this reading: the model's call, or the read of the kept answer. */
	latencyMs: number;
	/**
	 * `null` — this call's answer; `cached` — kept from an earlier parse of the same text; `stored` — given again by the
	 * demo seed (`ExtractResponse.stored`). The model was not called for the last two.
	 */
	origin: KeptOrigin | null;
}

type KeptExtract = Omit<TextExtract, 'latencyMs' | 'origin'>;

/** Where the answers are kept. */
export interface TextParseCache {
	read(key: string): Promise<string | null>;
	write(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export function redisTextParseCache(client: () => Promise<Redis>): TextParseCache {
	return {
		async read(key) {
			return (await client()).get(key);
		},
		async write(key, value, ttlSeconds) {
			await (await client()).set(key, value, { expiration: { type: 'EX', value: ttlSeconds } });
		}
	};
}

/** Answers kept in the process: the evaluation catalog, whose parses live as long as its run. */
export function memoryTextParseCache(): TextParseCache {
	const kept = new Map<string, string>();
	return {
		read: (key) => Promise.resolve(kept.get(key) ?? null),
		write: (key, value) => {
			kept.set(key, value);
			return Promise.resolve();
		}
	};
}

const keptSchema = vacancyOutputSchema.extend({ model: modelInfoSchema }) satisfies z.ZodType<KeptExtract>;

/**
 * The shape of a kept answer, in its key: an answer kept in another shape — before a change of the output schema that
 * did not change `VACANCY_SCHEMA_VERSION` — is not found, rather than found and refused.
 */
export const KEPT_SHAPE = createHash('sha256')
	.update(JSON.stringify(z.toJSONSchema(keptSchema)))
	.digest('hex')
	.slice(0, 12);

export interface TextExtractDeps {
	models: Pick<ModelAdapter, 'extract' | 'extractModelKey'>;
	parseCache: TextParseCache;
}

export interface TextExtractInput {
	companyId: string;
	/** `ml_results.input_sha256` of the parse: the hash of the text. */
	inputSha256: string;
	/** The vacancy or the need the text is read for. */
	inputId: string;
	taxonomyVersionId: string;
	blocks: readonly Block[];
}

const cacheKey = (model: string, input: TextExtractInput) =>
	`text-parse:${VACANCY_SCHEMA_VERSION}:${KEPT_SHAPE}:${encodeURIComponent(model)}:${input.taxonomyVersionId}:${input.companyId}:${input.inputSha256}`;

/**
 * The kept answer under the key, or `null` when there is none — or none to be had: the store did not answer in time or
 * failed, or what it keeps is not a kept answer. Said in the log by its reason only: the answer quotes the text.
 */
async function readKept(cache: TextParseCache, key: string): Promise<KeptExtract | null> {
	let raw: string | null;
	try {
		raw = await withTimeout(cache.read(key), TEXT_PARSE_CACHE_WAIT_MS, 'text parse cache');
	} catch (error) {
		console.warn('[text-parse] kept answer not read, the model is asked', loggedError(error));
		return null;
	}
	if (raw === null) return null;
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		console.warn('[text-parse] kept answer is not JSON, the model is asked');
		return null;
	}
	const kept = keptSchema.safeParse(json);
	if (!kept.success) {
		console.warn('[text-parse] kept answer has another shape, the model is asked', {
			issues: kept.error.issues.map((issue) => ({ code: issue.code, path: issue.path.join('.') }))
		});
		return null;
	}
	return kept.data;
}

/** Keeps the answer; one not kept is said in the log, and the parse goes on with the answer it has. */
async function writeKept(cache: TextParseCache, key: string, kept: KeptExtract): Promise<void> {
	try {
		await withTimeout(
			cache.write(key, JSON.stringify(kept), TEXT_PARSE_CACHE_SECONDS),
			TEXT_PARSE_CACHE_WAIT_MS,
			'text parse cache'
		);
	} catch (error) {
		console.warn('[text-parse] answer not kept', loggedError(error));
	}
}

/**
 * The model's reading of the blocks of a pasted text: the kept answer to the same text, or a call of the model, whose
 * answer is then kept. A failure of the model is returned as it is: the caller reads the text by the rules.
 */
export async function extractPastedText(
	deps: TextExtractDeps,
	input: TextExtractInput,
	lexicon: VacancyLexicon,
	options: Pick<CallOptions, 'signal'> = {}
): Promise<ModelResult<TextExtract>> {
	const started = Date.now();
	// Without a model the call would make, the call below fails as it is; nothing is read or kept for no model.
	const model = await deps.models.extractModelKey();
	const key = model === null ? null : cacheKey(model, input);
	const kept = key === null ? null : await readKept(deps.parseCache, key);
	if (kept !== null) return ok({ ...kept, latencyMs: Date.now() - started, origin: 'cached' });
	const response = await deps.models.extract(
		{
			schemaVersion: VACANCY_SCHEMA_VERSION,
			input: { type: 'vacancy', id: input.inputId, revision: 0 },
			taxonomyVersionId: input.taxonomyVersionId,
			blocks: input.blocks
		},
		lexicon,
		{ priority: 'interactive', ...(options.signal ? { signal: options.signal } : {}) }
	);
	if (!response.ok) return response;
	const answer = keptOf(response.value);
	if (key !== null) await writeKept(deps.parseCache, key, answer);
	return ok({
		...answer,
		latencyMs: response.value.latencyMs,
		origin: response.value.stored === true ? 'stored' : null
	});
}

function keptOf(answer: ExtractResponse<VacancyItem>): KeptExtract {
	return {
		model: answer.model,
		items: answer.items,
		rejectedReasons: answer.rejected.map((rejected) => rejected.reason)
	};
}
