// The `model` of an `extract` envelope (`ml_results.model`, domain 16.1): which model answered and through which
// runtime profile — the record of whether the text went to an external model or stayed with our own.
import type { ModelInfo } from './adapter';
import { LLM_RUNTIMES, type LlmRuntime } from './runtime';

export interface ExtractModelEnvelope {
	endpoint_profile: 'extract';
	model_id: string;
	model_revision: string | null;
	runtime: LlmRuntime;
	params: Record<string, unknown>;
	/** Absent — this call's answer; otherwise the model gave it earlier and it was given again without a call. */
	origin?: KeptOrigin;
}

/**
 * Where an answer the model gave earlier came from when it is given again without a call: `stored` — the stored
 * parses of the demo seed (`demo/model-parses.ts`), `cached` — the answer kept for a day to the same pasted text
 * (`vacancies/text-extract.ts`).
 */
export const KEPT_ORIGINS = ['stored', 'cached'] as const;
export type KeptOrigin = (typeof KEPT_ORIGINS)[number];

/** `origin: null` — the answer of this call. */
export function extractModelEnvelope(model: ModelInfo, origin: KeptOrigin | null): ExtractModelEnvelope {
	return {
		endpoint_profile: 'extract',
		model_id: model.modelId,
		model_revision: model.modelRevision,
		runtime: model.runtime,
		params: model.params,
		...(origin === null ? {} : { origin })
	};
}

/** What a reading shows of the model that made it. */
export interface ModelReading {
	modelId: string;
	/** `null` — an envelope written before the runtime was recorded: where the text went is not known. */
	runtime: LlmRuntime | null;
	/** The answer was the one kept for a day to the same text: the model was not called for this reading. */
	cached: boolean;
}

/** Reads the `model` of an `extract` envelope written with the model; anything else is a broken envelope. */
export function readModelEnvelope(model: unknown): ModelReading {
	if (typeof model !== 'object' || model === null) throw new Error('extract envelope has no model');
	const { model_id: modelId, runtime, origin } = model as { model_id?: unknown; runtime?: unknown; origin?: unknown };
	if (typeof modelId !== 'string') throw new Error('extract envelope has no model id');
	if (origin !== undefined && !KEPT_ORIGINS.some((value) => value === origin)) {
		throw new Error('extract envelope names an unknown origin');
	}
	const cached = origin === 'cached';
	if (runtime === undefined) return { modelId, runtime: null, cached };
	const known = LLM_RUNTIMES.find((value) => value === runtime);
	if (!known) throw new Error('extract envelope names an unknown runtime');
	return { modelId, runtime: known, cached };
}
