// The model's reading of a pasted text — a vacancy (`from-text.ts`) or a hiring need (`needs/parse.ts`), both of the
// schema `vacancy-extract/v2` — kept by the hash of the text (`ml_results.input_sha256`). An employer who pastes the
// same text again, or asks for the parse again, gets the answer the model gave, and the model is not called: the
// spending of the gateway does not grow with repeats. An answer is kept per company, taxonomy version, schema and the
// configured model for a day: after the model is changed, the answers of the previous one are not given out. Only an
// answer of the model is kept — a failed call is not, so the next parse asks the model again.
import { z } from 'zod';
import type { CallOptions, ExtractResponse, ModelAdapter, ModelInfo } from '$lib/server/ml/adapter';
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

/** What a parse records of the model's answer. */
export interface TextExtract {
	model: ModelInfo;
	items: VacancyItem[];
	rejectedReasons: RejectReason[];
	/** Time of this reading: the model's call, or the read of the kept answer. */
	latencyMs: number;
	/** The answer was kept from an earlier parse of the same text; the model was not called. */
	cached: boolean;
	/** The answer the model gave earlier, given again by the demo seed (`ExtractResponse.stored`); the model was not called. */
	stored: boolean;
}

type KeptExtract = Omit<TextExtract, 'latencyMs' | 'cached' | 'stored'>;

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
	`text-parse:${VACANCY_SCHEMA_VERSION}:${encodeURIComponent(model)}:${input.taxonomyVersionId}:${input.companyId}:${input.inputSha256}`;

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
	// Without a configured model the call below fails as it is; nothing is read or kept for no model.
	const model = deps.models.extractModelKey();
	const key = model === null ? null : cacheKey(model, input);
	const stored = key === null ? null : await deps.parseCache.read(key);
	if (stored !== null) {
		const kept = keptSchema.parse(JSON.parse(stored));
		return ok({ ...kept, latencyMs: Date.now() - started, cached: true, stored: false });
	}
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
	const kept = keptOf(response.value);
	if (key !== null) await deps.parseCache.write(key, JSON.stringify(kept), TEXT_PARSE_CACHE_SECONDS);
	return ok({ ...kept, latencyMs: response.value.latencyMs, cached: false, stored: response.value.stored === true });
}

function keptOf(answer: ExtractResponse<VacancyItem>): KeptExtract {
	return {
		model: answer.model,
		items: answer.items,
		rejectedReasons: answer.rejected.map((rejected) => rejected.reason)
	};
}
