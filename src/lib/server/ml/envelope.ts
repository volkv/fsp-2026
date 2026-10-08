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
	/** `stored` — the model gave this answer earlier and it was given again without a call; absent — this call's answer. */
	origin?: 'stored';
}

export function extractModelEnvelope(model: ModelInfo, stored: boolean): ExtractModelEnvelope {
	return {
		endpoint_profile: 'extract',
		model_id: model.modelId,
		model_revision: model.modelRevision,
		runtime: model.runtime,
		params: model.params,
		...(stored ? { origin: 'stored' as const } : {})
	};
}

/** What a reading shows of the model that made it. */
export interface ModelReading {
	modelId: string;
	/** `null` — an envelope written before the runtime was recorded: where the text went is not known. */
	runtime: LlmRuntime | null;
}

/** Reads the `model` of an `extract` envelope written with the model; anything else is a broken envelope. */
export function readModelEnvelope(model: unknown): ModelReading {
	if (typeof model !== 'object' || model === null) throw new Error('extract envelope has no model');
	const { model_id: modelId, runtime } = model as { model_id?: unknown; runtime?: unknown };
	if (typeof modelId !== 'string') throw new Error('extract envelope has no model id');
	if (runtime === undefined) return { modelId, runtime: null };
	const known = LLM_RUNTIMES.find((value) => value === runtime);
	if (!known) throw new Error('extract envelope names an unknown runtime');
	return { modelId, runtime: known };
}
