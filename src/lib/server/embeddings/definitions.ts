// Embedding spaces the product knows (docs/domain.md, section 16.2). A space is registered from its definition here, by
// `EMBED_SPACE_ID`, and its row never changes afterwards: another model file, pooling, prefix, dimension, input limit or
// way of cutting texts into sections is another definition with another identifier, and a new space is built by
// `embedding.reindex` before search switches to it.

export interface SpaceDefinition {
	id: string;
	/** `EMBED_MODEL` must name it; the runtime serves the model under this name. */
	modelName: string;
	/** SHA-256 of the model file the runtime loads. */
	modelRevision: string;
	dimension: number;
	queryPrefix: string;
	documentPrefix: string;
	pooling: 'mean' | 'cls' | 'last_token' | 'provider_default';
	normalization: 'l2' | 'none';
	/** Tokens of one input the runtime accepts; the texts of the sections are cut to fit (text.ts). */
	maxInputTokens: number;
	/** Version of the section texts (text.ts, profile.ts): a change of what goes into a text is a new space. */
	chunkingVersion: string;
}

/** Everything but the identifier, which is derived from the rest. */
type SpaceParams = Omit<SpaceDefinition, 'id'>;

/**
 * `model@revision/q:<query prefix>/d:<document prefix>/pooling/normalization/dimension/t<tokens>/chunking`: two
 * definitions that differ in anything get different identifiers. A prefix is named by a short name the definition gives
 * it, `none` when it is empty.
 */
function spaceId(params: SpaceParams, prefixNames: { query: string; document: string }): string {
	return [
		`${params.modelName}@${params.modelRevision.slice(0, 12)}`,
		`q:${prefixNames.query}`,
		`d:${prefixNames.document}`,
		params.pooling,
		params.normalization,
		String(params.dimension),
		`t${params.maxInputTokens}`,
		params.chunkingVersion
	].join('/');
}

function define(params: SpaceParams, prefixNames: { query: string; document: string }): SpaceDefinition {
	return { id: spaceId(params, prefixNames), ...params };
}

/**
 * BAAI bge-m3, GGUF Q8_0 (huggingface.co/ggml-org/bge-m3-Q8_0-GGUF, file bge-m3-q8_0.gguf) on the CPU runtime of the
 * `embedder` service: CLS pooling, no instructions, unit vectors of 1024 dimensions. The runtime's physical batch is
 * 512 tokens: a longer input is refused as a server error and the memory of attention grows with the square of the
 * input, so the stand keeps inputs this short.
 */
export const BGE_M3_Q8: SpaceDefinition = define(
	{
		modelName: 'bge-m3',
		modelRevision: 'aa473d51f451a22f0fcf39ba3330c14bed38a385712b1113440f69df4047a173',
		dimension: 1024,
		queryPrefix: '',
		documentPrefix: '',
		pooling: 'cls',
		normalization: 'l2',
		maxInputTokens: 512,
		chunkingVersion: 'sections-v1'
	},
	{ query: 'none', document: 'none' }
);

export const SPACE_DEFINITIONS: readonly SpaceDefinition[] = [BGE_M3_Q8];

export function spaceDefinition(id: string): SpaceDefinition | null {
	return SPACE_DEFINITIONS.find((definition) => definition.id === id) ?? null;
}
