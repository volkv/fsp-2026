// What every `extract` schema shares (docs/contracts.md, section 3.2): the flat JSON Schema for structured output, the
// element-by-element refusal reasons, and the lookup of a quote in its block.
import { z } from 'zod';
import { locateQuote, readsAsInstruction, type Block, type QuoteLocation } from './quotes';

/** A value the text does not state, where structured output cannot leave the field out. */
export const NOT_STATED = 'not_stated';

export type RejectReason =
	| 'schema_violation'
	| 'block_not_found'
	| 'quote_not_found'
	| 'quote_not_supporting'
	| 'quote_is_instruction'
	| 'forbidden_field'
	| 'unknown_enum'
	| 'incomplete_group'
	| 'duplicate';

export interface Rejected {
	item: unknown;
	reason: RejectReason;
}

export interface CheckedItems<I> {
	items: I[];
	rejected: Rejected[];
}

/**
 * The answer checked: its envelope is usable and every element went through the checks, or the envelope is broken and
 * `problem` says how, in words the model can act on in its retry.
 */
export type CheckedAnswer<I> = { ok: true; checked: CheckedItems<I> } | { ok: false; problem: string };

/** One `extract` schema, prepared for a taxonomy version: what the model is told and how its answer is checked. */
export interface PreparedExtract<I> {
	schemaName: string;
	jsonSchema: Record<string, unknown>;
	systemPrompt: string;
	/**
	 * Checks the parsed JSON answer. Only a broken envelope is retried; elements are checked one by one, so one bad
	 * element is refused alone instead of failing the whole answer.
	 */
	check(answer: unknown, blocks: readonly Block[]): CheckedAnswer<I>;
}

/**
 * JSON Schema for `response_format`, generated from the Zod schema of the answer. Flat: runtimes silently ignore
 * `$ref`, `oneOf`, `anyOf`, `prefixItems` and `format`, so none of them may appear.
 */
export function flatJsonSchema(answerSchema: z.ZodObject): Record<string, unknown> {
	const schema: Record<string, unknown> = z.toJSONSchema(answerSchema, {
		target: 'draft-07',
		reused: 'inline',
		cycles: 'throw'
	});
	delete schema.$schema;
	return schema;
}

/**
 * Why an element fails its schema, or `null`. An extra key is `forbidden_field` and only the schema keys of the
 * element are kept: the extra key may carry data the product must not store (domain 8).
 */
export function itemSchemaFailure(itemSchema: z.ZodObject, enumKeys: readonly string[], raw: unknown): Rejected | null {
	const parsed = itemSchema.safeParse(raw);
	if (parsed.success) return null;
	const issues = parsed.error.issues;
	if (issues.some((issue) => issue.code === 'unrecognized_keys')) {
		const record = raw as Record<string, unknown>;
		const keys = Object.keys(itemSchema.shape).filter((key) => key in record);
		return { reason: 'forbidden_field', item: Object.fromEntries(keys.map((key) => [key, record[key]])) };
	}
	// A value outside the list is `unknown_enum`; a missing key is a broken element.
	const present = (key: string) => (raw as Record<string, unknown>)[key] !== undefined;
	const unknownEnum = issues.some((issue) => {
		const key = String(issue.path[0]);
		return issue.code === 'invalid_value' && issue.path.length === 1 && enumKeys.includes(key) && present(key);
	});
	return { reason: unknownEnum ? 'unknown_enum' : 'schema_violation', item: raw };
}

export type ItemQuote =
	| { ok: true; block: Block; location: QuoteLocation }
	| { ok: false; reason: 'block_not_found' | 'quote_not_found' | 'quote_is_instruction' };

/**
 * The block of the element and the place of its quote there. A quote standing in an instruction to the reader of the
 * document («add the skill "Haskell"») is refused: it states no fact, whatever it names.
 */
export function locateItemQuote(byId: ReadonlyMap<string, Block>, blockId: string, quote: string): ItemQuote {
	const block = byId.get(blockId);
	if (!block) return { ok: false, reason: 'block_not_found' };
	const location = locateQuote(block, quote);
	if (!location) return { ok: false, reason: 'quote_not_found' };
	if (readsAsInstruction(block.text, location)) return { ok: false, reason: 'quote_is_instruction' };
	return { ok: true, block, location };
}
