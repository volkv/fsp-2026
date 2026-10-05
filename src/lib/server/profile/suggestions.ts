// What the reading of a resume suggests for the candidate's own profile fields (docs/domain.md, sections 7.1, 15;
// docs/contracts.md, section 3.2): the name, the phone, the e-mail, Telegram and the soft skills, each with the place of
// its quote in the extraction text. They are not evidence and reach nobody but the candidate: accepting one writes the
// value into the profile, as typing it would; rejecting one only records the decision. The values are personal data:
// stored encrypted, the quote kept as offsets only (its words are the extraction's).
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Executor, Transaction } from '$lib/server/db';
import { PROFILE_SUGGESTION_FIELDS, profileSuggestions } from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import { isProfileItem, type ResumeItem } from '$lib/server/ml/resume-extract';
import { sliceByCodePoints } from '$lib/text/offsets';
import {
	fullNameText,
	normalizeEmail,
	normalizePhone,
	normalizeTelegram,
	parseFullName,
	type FullName
} from './contacts';
import { softSkillName, softSkillOf } from './soft-skills';

export type SuggestionField = (typeof PROFILE_SUGGESTION_FIELDS)[number];

export interface SuggestionDraft {
	id: string;
	field: SuggestionField;
	/** The normalized value: the JSON of the name parts, a contact, or a soft skill key. */
	value: string;
	quote: { block_id: string; start: number; end: number };
}

const FIELD_OF_KIND = {
	full_name: 'full_name',
	contact_phone: 'phone',
	contact_email: 'email',
	contact_telegram: 'telegram',
	soft_skill: 'soft_skill'
} as const satisfies Record<string, SuggestionField>;

/** The normalized value of a profile item, or `null` when it does not read as one (the checks passed its quote only). */
function valueOf(item: ResumeItem & { kind: keyof typeof FIELD_OF_KIND }): string | null {
	switch (item.kind) {
		case 'full_name': {
			const name = parseFullName(item.rawText);
			return name === null ? null : JSON.stringify(name);
		}
		case 'contact_phone':
			return normalizePhone(item.rawText);
		case 'contact_email':
			return normalizeEmail(item.rawText);
		case 'contact_telegram':
			return normalizeTelegram(item.rawText);
		case 'soft_skill':
			return softSkillOf(item.rawText)?.key ?? null;
	}
}

/**
 * The suggestions of the checked items of one reading: asserted values only (a quality the person denies is not
 * suggested), each value once, one name — the first.
 */
export function planProfileSuggestions(items: readonly ResumeItem[]): SuggestionDraft[] {
	const drafts: SuggestionDraft[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (!isProfileItem(item) || item.polarity !== 'asserted') continue;
		const field = FIELD_OF_KIND[item.kind];
		const value = valueOf(item);
		if (value === null) continue;
		const key = field === 'full_name' ? field : `${field}:${value}`;
		if (seen.has(key)) continue;
		seen.add(key);
		drafts.push({
			id: uuidv7(),
			field,
			value,
			quote: { block_id: item.quote.blockId, start: item.quote.start, end: item.quote.end }
		});
	}
	return drafts;
}

export async function insertProfileSuggestions(
	tx: Transaction,
	crypto: FieldCrypto,
	input: { candidateId: string; extractionId: string; drafts: readonly SuggestionDraft[] }
): Promise<void> {
	if (input.drafts.length === 0) return;
	await tx.insert(profileSuggestions).values(
		input.drafts.map((draft) => ({
			id: draft.id,
			candidateId: input.candidateId,
			extractionId: input.extractionId,
			field: draft.field,
			valueEnc: draft.field === 'soft_skill' ? null : crypto.encrypt(draft.value, 'profile_suggestions.value'),
			skillKey: draft.field === 'soft_skill' ? draft.value : null,
			quote: draft.quote,
			status: 'pending' as const
		}))
	);
}

const storedQuote = z.strictObject({ block_id: z.string().min(1), start: z.int().min(0), end: z.int().min(1) });
const storedBlocks = z.array(z.object({ id: z.string(), start: z.int().min(0), end: z.int().min(1) }));
const fullNameSchema = z.strictObject({ last: z.string(), first: z.string(), middle: z.string().nullable() });

/** A suggestion as the candidate sees it: the value in words, the quote with its words, the decision. */
export interface SuggestionView {
	id: string;
	field: SuggestionField;
	/** The value as stored (a contact, a soft skill key) or, for the name, its parts. */
	value: string;
	name: FullName | null;
	/** The value in words: the name as «Фамилия Имя Отчество», the soft skill by its name. */
	label: string;
	status: (typeof profileSuggestions.$inferSelect)['status'];
	quote: { extractionId: string; blockId: string; start: number; end: number; text: string };
	/** The key its quote is marked with in the resume text of the pages. */
	sourceKey: string;
}

/**
 * The suggestions of one reading of the candidate's current resume, by field in the order of the form, then in the
 * order of the text. A quote that does not fit its block is a defect of the stored data and fails loudly.
 */
export async function readSuggestions(
	executor: Executor,
	crypto: FieldCrypto,
	candidateId: string,
	document: { extractionId: string; text: string; blocks: unknown }
): Promise<SuggestionView[]> {
	const rows = await executor
		.select()
		.from(profileSuggestions)
		.where(
			and(eq(profileSuggestions.candidateId, candidateId), eq(profileSuggestions.extractionId, document.extractionId))
		);
	const parsedBlocks = storedBlocks.parse(document.blocks);
	const blocks = new Map(parsedBlocks.map((block) => [block.id, block]));
	const views = rows.map((row) => {
		const quote = storedQuote.parse(row.quote);
		const block = blocks.get(quote.block_id);
		if (!block) throw new Error(`suggestion ${row.id} quotes block ${quote.block_id} missing from its extraction`);
		const blockText = sliceByCodePoints(document.text, block);
		const text = sliceByCodePoints(blockText, quote);
		if (text.length === 0) throw new Error(`suggestion ${row.id} quotes outside block ${quote.block_id}`);
		const value =
			row.field === 'soft_skill' ? requireValue(row.skillKey, row.id) : decryptValue(crypto, row.valueEnc, row.id);
		const name = row.field === 'full_name' ? fullNameSchema.parse(JSON.parse(value)) : null;
		return {
			id: row.id,
			field: row.field,
			value,
			name,
			label: name !== null ? fullNameText(name) : row.field === 'soft_skill' ? softSkillName(value) : value,
			status: row.status,
			quote: { extractionId: document.extractionId, blockId: quote.block_id, start: quote.start, end: quote.end, text },
			sourceKey: `suggestion:${row.id}`
		};
	});
	const placeOf = (view: SuggestionView) => (blocks.get(view.quote.blockId)?.start ?? 0) + view.quote.start;
	return views.sort(
		(a, b) =>
			PROFILE_SUGGESTION_FIELDS.indexOf(a.field) - PROFILE_SUGGESTION_FIELDS.indexOf(b.field) || placeOf(a) - placeOf(b)
	);
}

function requireValue(value: string | null, id: string): string {
	if (value === null) throw new Error(`suggestion ${id} has no value`);
	return value;
}

function decryptValue(crypto: FieldCrypto, sealed: Uint8Array | null, id: string): string {
	if (sealed === null) throw new Error(`suggestion ${id} has no value`);
	return crypto.decrypt(sealed, 'profile_suggestions.value');
}

/** Removes the suggestions of the given readings: their resume is deleted. */
export async function deleteSuggestionsOf(tx: Transaction, extractionIds: readonly string[]): Promise<void> {
	if (extractionIds.length === 0) return;
	await tx.delete(profileSuggestions).where(inArray(profileSuggestions.extractionId, extractionIds));
}
