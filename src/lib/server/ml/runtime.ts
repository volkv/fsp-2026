// Profiles of the `extract` runtime (`LLM_RUNTIME`): what the product must know about the server behind `LLM_BASE_URL`
// beyond the OpenAI-compatible protocol both speak (docs/models.md, «Три режима»). The request body is the same
// for both — model, messages, max_tokens, response_format — except the sampling and the answer format the profile
// sets, and has nothing a strict gateway refuses.

export const LLM_RUNTIMES = ['api', 'vllm'] as const;

/**
 * - `api` — an external model behind an OpenAI-compatible API (the demonstration stand: Claude Sonnet through a
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
	/**
	 * The output limit and, where the runtime takes it, the sampling of `extract`: reproducible, not creative. Claude
	 * refuses `temperature` (400), so the external profile sends none.
	 */
	params: { temperature?: 0; max_tokens: number };
	/**
	 * How the answer is held to the schema of the operation. `json_schema` — the runtime decodes under the strict schema
	 * of `response_format`. `json_object` — the schema goes in the system prompt and the runtime answers in JSON mode:
	 * Claude compiles a strict schema into a grammar and refuses the resume schema as too large (400 `The compiled
	 * grammar is too large`). Either way the product checks the answer itself and retries once (adapter.ts).
	 */
	answerFormat: 'json_schema' | 'json_object';
}

export const RUNTIME_PROFILES: Record<LlmRuntime, RuntimeProfile> = {
	api: {
		hosting: 'external',
		requiresApiKey: true,
		// A reasoning model counts its thinking in the output budget: on the corpus measured with the previous external
		// model (docs/models.md) a resume took up to 4 127 output tokens, 3 326 of them thinking; 16 384 leaves four
		// times that.
		params: { max_tokens: 16_384 },
		answerFormat: 'json_object'
	},
	vllm: {
		hosting: 'own',
		requiresApiKey: false,
		// vLLM refuses a prompt plus max_tokens above its context (16 384, docs/models.md): 8 192 keeps prompts up to
		// 8 192 tokens. Thinking is off on the server (`enable_thinking: false`).
		params: { temperature: 0, max_tokens: 8_192 },
		answerFormat: 'json_schema'
	}
};

/** The runtime requires a key and none is set: `extract` is off with the reason `no_api_key`. */
export function lacksApiKey(settings: { runtime: LlmRuntime; apiKey: string | null }): boolean {
	return RUNTIME_PROFILES[settings.runtime].requiresApiKey && !settings.apiKey;
}
