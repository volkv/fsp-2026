// The model's parses the demo seed gives again (`seeds/model-parses.json`; docs/deploy.md, «Бюджет шлюза модели»): the
// texts of the heroes' resumes and of the scenario needs do not change from one seed to the next, so the answer of the
// model to them does not either, and a seed does not pay for it again. An answer is found by the schema of the
// operation, the label of the taxonomy version and the hash of the input — the `ml_results.input_sha256` of the reading.
// A found answer is written as the model's (`processing_mode = model`, the envelope marked `origin: stored`) without a
// call. A text without a stored answer is read by the rules with the reason `demo_seed_not_stored`, and the seed names
// its key in one warning; the model is called for it only when the seed is told so (`DEMO_SEED_MODEL=live`).
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { SeedModelMode } from '$lib/server/config';
import type { Database } from '$lib/server/db';
import { taxonomyVersions } from '$lib/server/db/schema';
import type {
	CallOptions,
	ExtractRequest,
	ExtractResponse,
	ExtractSchemas,
	ExtractSchemaVersion,
	ModelAdapter
} from '$lib/server/ml/adapter';
import {
	modelInfoSchema,
	resumeOutputSchema,
	vacancyOutputSchema,
	type ResumeOutput,
	type VacancyOutput
} from '$lib/server/ml/extract-output';
import { fail, ok, type ModelResult } from '$lib/server/ml/result';
import { resumeInputSha256 } from '$lib/server/resumes/extract-job';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const common = {
	taxonomy: z.string().min(1),
	inputSha256: sha256,
	/** What the text is, for a reader of the file: `resume k1`, `need severny_kod.backend`. */
	about: z.string().min(1),
	model: modelInfoSchema
};

export const modelParsesFile = z.object({
	description: z.string(),
	parses: z.array(
		z.discriminatedUnion('schemaVersion', [
			z.object({ schemaVersion: z.literal('resume-extract/v3'), ...common, output: resumeOutputSchema }),
			z.object({ schemaVersion: z.literal('vacancy-extract/v2'), ...common, output: vacancyOutputSchema })
		])
	)
});

export type ModelParsesFile = z.infer<typeof modelParsesFile>;
export type StoredParse = ModelParsesFile['parses'][number];

export function parseKey(schemaVersion: string, taxonomyLabel: string, inputSha256: string): string {
	return `${schemaVersion}:${taxonomyLabel}:${inputSha256}`;
}

/** The stored parses by their key; one answer per key. */
export function storedParses(file: ModelParsesFile): ReadonlyMap<string, StoredParse> {
	const byKey = new Map<string, StoredParse>();
	for (const parse of file.parses) {
		const key = parseKey(parse.schemaVersion, parse.taxonomy, parse.inputSha256);
		if (byKey.has(key)) throw new Error(`seeds/model-parses.json: ${key} is stored twice`);
		byKey.set(key, parse);
	}
	return byKey;
}

type Extractor = Pick<ModelAdapter, 'extract' | 'extractModelKey'>;
type Answer<V extends ExtractSchemaVersion> = ModelResult<ExtractResponse<ExtractSchemas[V]['item']>>;

export interface SeedModelsDeps {
	db: Database;
	parses: ReadonlyMap<string, StoredParse>;
	/** `stored` — stored answers or the rules; `live` — stored answers, the model for a text without one. */
	mode: SeedModelMode;
	/** The product's model adapter: called in the `live` mode only. */
	models: () => Extractor;
}

/** What the seed's readings got: stored answers, calls of the model, and the keys without a stored answer. */
export interface SeedParses {
	stored: number;
	live: number;
	missing: string[];
}

/** The `extract` of the heroes' resumes and of the scenario needs during one seed. */
export class SeedModels {
	readonly #deps: SeedModelsDeps;
	readonly #labels = new Map<string, string>();
	readonly #missing = new Set<string>();
	#stored = 0;
	#live = 0;

	constructor(deps: SeedModelsDeps) {
		this.#deps = deps;
	}

	/** A hero's resume: the key is the hash of its blocks, as the resume's reading records it. */
	resume(): Pick<ModelAdapter, 'extract'> {
		return {
			extract: (request, lexicon, options) =>
				this.#extract(resumeInputSha256(request.blocks), request, lexicon, options)
		};
	}

	/**
	 * The text of a scenario need: the key is the hash of the text, as the need's parse records it. Only the `live` mode
	 * names the configured model, so only then the parse keeps the answer for a day (`vacancies/text-extract.ts`).
	 */
	need(text: string): Extractor {
		const inputSha256 = createHash('sha256').update(text).digest('hex');
		return {
			extract: (request, lexicon, options) => this.#extract(inputSha256, request, lexicon, options),
			extractModelKey: () =>
				this.#deps.mode === 'live' ? this.#deps.models().extractModelKey() : Promise.resolve(null)
		};
	}

	summary(): SeedParses {
		return { stored: this.#stored, live: this.#live, missing: [...this.#missing].sort() };
	}

	async #label(taxonomyVersionId: string): Promise<string> {
		const known = this.#labels.get(taxonomyVersionId);
		if (known !== undefined) return known;
		const [row] = await this.#deps.db
			.select({ label: taxonomyVersions.label })
			.from(taxonomyVersions)
			.where(eq(taxonomyVersions.id, taxonomyVersionId));
		if (!row) throw new Error(`taxonomy version ${taxonomyVersionId} is missing`);
		this.#labels.set(taxonomyVersionId, row.label);
		return row.label;
	}

	async #extract<V extends ExtractSchemaVersion>(
		inputSha256: string,
		request: ExtractRequest<V>,
		lexicon: ExtractSchemas[V]['lexicon'],
		options?: CallOptions
	): Promise<Answer<V>> {
		const key = parseKey(request.schemaVersion, await this.#label(request.taxonomyVersionId), inputSha256);
		const stored = this.#deps.parses.get(key);
		if (stored) {
			this.#stored++;
			return given(stored) as Answer<V>;
		}
		if (this.#deps.mode === 'live') {
			this.#live++;
			return this.#deps.models().extract(request, lexicon, options);
		}
		this.#missing.add(key);
		return fail('disabled', 'extract: the demo seed has no stored parse of this text', {
			reason: 'demo_seed_not_stored'
		});
	}
}

/**
 * The stored answer as the adapter gives one, marked stored. The key holds the schema, so the answer is of the
 * request's schema; TypeScript cannot follow that through the key, hence the cast at the caller.
 */
function given(parse: StoredParse): ModelResult<ExtractResponse<unknown>> {
	const answer = { model: parse.model, attempts: 0, latencyMs: 0, stored: true } as const;
	switch (parse.schemaVersion) {
		case 'resume-extract/v3': {
			const output: ResumeOutput = parse.output;
			return ok({ ...answer, items: output.items, rejected: output.rejected });
		}
		case 'vacancy-extract/v2': {
			const output: VacancyOutput = parse.output;
			return ok({
				...answer,
				items: output.items,
				rejected: output.rejectedReasons.map((reason) => ({ item: null, reason }))
			});
		}
	}
}
