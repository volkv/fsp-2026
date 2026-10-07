// Profiles of the `extract` runtime (`LLM_RUNTIME`): what the product must know about the server behind `LLM_BASE_URL`
// beyond the OpenAI-compatible protocol both speak (docs/models.md, «Три режима»). The request body is the same
// for both — model, messages, temperature, max_tokens, response_format — and has nothing a strict gateway refuses.

export const LLM_RUNTIMES = ['api', 'vllm'] as const;

/**
 * - `api` — an external model behind an OpenAI-compatible API (the demonstration stand: Gemini Flash through a
 *   gateway). The text leaves the platform's perimeter; the provider requires a key.
 * - `vllm` — the platform's own vLLM server with an open model on one GPU (docs/models.md). The text stays inside the
 *   perimeter; a key is needed only when the server was started with `--api-key`.
 */
export type LlmRuntime = (typeof LLM_RUNTIMES)[number];

export interface RuntimeProfile {
	/** Where the text of a resume, a need or a vacancy goes: shown to people next to every reading of the model. */
	hosting: 'external' | 'own';
	/** Without `LLM_API_KEY` the operation is off (`disabled`, reason `no_api_key`) instead of calling and failing. */
	requiresApiKey: boolean;
	/** Sampling of `extract`: reproducible, not creative. */
	params: { temperature: 0; max_tokens: number };
	/**
	 * The schema of `response_format` keeps the `maxItems` bounds of its arrays. They stop a greedy small model from
	 * looping up to the output limit (resume-extract.ts); Gemini refuses a schema whose arrays of objects are bounded
	 * this high (`INVALID_ARGUMENT`), so for it they are left out of the request and the product's own check of the
	 * answer, which keeps them, refuses an answer above a bound.
	 */
	boundedArrays: boolean;
}

export const RUNTIME_PROFILES: Record<LlmRuntime, RuntimeProfile> = {
	api: {
		hosting: 'external',
		requiresApiKey: true,
		// A reasoning model counts its thinking in the output budget: on the measured corpus (docs/models.md) a resume took
		// up to 4 127 output tokens, 3 326 of them thinking; 16 384 leaves four times that.
		params: { temperature: 0, max_tokens: 16_384 },
		boundedArrays: false
	},
	vllm: {
		hosting: 'own',
		requiresApiKey: false,
		// vLLM refuses a prompt plus max_tokens above its context (16 384, docs/models.md): 8 192 keeps prompts up to
		// 8 192 tokens. Thinking is off on the server (`enable_thinking: false`).
		params: { temperature: 0, max_tokens: 8_192 },
		boundedArrays: true
	}
};

/** The JSON Schema of `response_format` as the runtime of the profile accepts it. */
export function requestSchema(profile: RuntimeProfile, schema: Record<string, unknown>): Record<string, unknown> {
	return profile.boundedArrays ? schema : (withoutMaxItems(schema) as Record<string, unknown>);
}

/** Drops the `maxItems` keyword; a field of that name in `properties` is a field, not the keyword, and stays. */
function withoutMaxItems(node: unknown, fields = false): unknown {
	if (Array.isArray(node)) return node.map((value) => withoutMaxItems(value));
	if (typeof node !== 'object' || node === null) return node;
	return Object.fromEntries(
		Object.entries(node)
			.filter(([key]) => fields || key !== 'maxItems')
			.map(([key, value]) => [key, withoutMaxItems(value, !fields && key === 'properties')])
	);
}

/** The runtime requires a key and none is set: `extract` is off with the reason `no_api_key`. */
export function lacksApiKey(settings: { runtime: LlmRuntime; apiKey: string | null }): boolean {
	return RUNTIME_PROFILES[settings.runtime].requiresApiKey && !settings.apiKey;
}
