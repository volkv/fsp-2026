// The resume screen of the candidate: the parsed text cut into its blocks, with the quotes of the extracted fields
// marked in it, so a click on a field opens the document at the words it rests on; the fields and experience entries
// with the candidate's decisions. Quotes and blocks are stored with code point offsets (docs/contracts.md, section 4.2);
// every conversion goes through `$lib/text/offsets`.
import { z } from 'zod';
import { codePointLength, codePointToUtf16, sliceByCodePoints } from '$lib/text/offsets';

export interface ResumeQuote {
	extractionId: string;
	blockId: string;
	/** Code points from the start of the block text. */
	start: number;
	end: number;
	text: string;
}

const storedQuote = z
	.strictObject({
		extraction_id: z.string().min(1),
		block_id: z.string().min(1),
		start: z.int().min(0),
		end: z.int().min(1),
		text: z.string().min(1)
	})
	.refine((quote) => quote.end > quote.start, { message: 'quote end is not after its start' });

const storedBlocks = z.array(
	z.object({
		id: z.string().min(1),
		page: z.int().min(1).nullable(),
		kind: z.enum(['heading', 'paragraph', 'list_item', 'table_cell', 'line']),
		start: z.int().min(0),
		end: z.int().min(1)
	})
);

export type BlockKind = z.infer<typeof storedBlocks>[number]['kind'];

function parsed<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
	const result = schema.safeParse(raw);
	if (!result.success) throw new Error(`${what} has an unexpected shape: ${z.prettifyError(result.error)}`);
	return result.data;
}

/** A stored quote of a claim; a quote of another shape is a defect of the stored evidence, not a missing quote. */
export function parseQuote(raw: unknown): ResumeQuote {
	const quote = parsed(storedQuote, raw, 'resume quote');
	return {
		extractionId: quote.extraction_id,
		blockId: quote.block_id,
		start: quote.start,
		end: quote.end,
		text: quote.text
	};
}

/** The stored quotes of an experience entry. */
export function parseQuotes(raw: unknown): ResumeQuote[] {
	return parsed(z.array(z.unknown()), raw, 'resume quotes').map(parseQuote);
}

/** A field of the page that points into the document: its key and the quotes it rests on. */
export interface QuoteSource {
	key: string;
	quotes: readonly ResumeQuote[];
}

/** A run of block text; `keys` are the sources whose quotes cover it, empty for text outside every quote. */
export interface Segment {
	text: string;
	keys: string[];
}

export interface BlockView {
	id: string;
	page: number | null;
	kind: BlockKind;
	segments: Segment[];
}

export interface DocumentView {
	blocks: BlockView[];
	/**
	 * Sources with at least one quote in this reading of the document. A quote of another reading (an older parser
	 * version) is not placed: its offsets belong to another text.
	 */
	located: string[];
}

interface Range {
	key: string;
	start: number;
	end: number;
}

/** Cuts the block text at every quote boundary; each piece knows which sources cover it. */
function segmentsOf(text: string, ranges: readonly Range[]): Segment[] {
	const cuts = [...new Set([0, codePointLength(text), ...ranges.flatMap((range) => [range.start, range.end])])].sort(
		(a, b) => a - b
	);
	const segments: Segment[] = [];
	for (let i = 0; i + 1 < cuts.length; i++) {
		const start = cuts[i] as number;
		const end = cuts[i + 1] as number;
		const keys = ranges.filter((range) => range.start <= start && range.end >= end).map((range) => range.key);
		segments.push({ text: text.slice(codePointToUtf16(text, start), codePointToUtf16(text, end)), keys });
	}
	return segments;
}

/**
 * The document text of one reading cut into its blocks, with the quotes of the sources marked. A quote of this reading
 * that names a missing block, lies outside it or differs from the block text is a defect of the stored evidence and
 * fails loudly: marking the wrong words would show the candidate a false origin of the field.
 */
export function documentView(
	document: { extractionId: string; text: string; blocks: unknown },
	sources: readonly QuoteSource[]
): DocumentView {
	const blocks = parsed(storedBlocks, document.blocks, 'document blocks').map((block) => ({
		...block,
		text: sliceByCodePoints(document.text, block)
	}));
	const byId = new Map(blocks.map((block) => [block.id, block]));
	const ranges = new Map<string, Range[]>();
	const located = new Set<string>();
	for (const source of sources) {
		for (const quote of source.quotes) {
			if (quote.extractionId !== document.extractionId) continue;
			const block = byId.get(quote.blockId);
			if (!block) throw new Error(`quote of ${source.key} names block ${quote.blockId} missing from the document`);
			if (quote.end > codePointLength(block.text)) {
				throw new Error(`quote of ${source.key} lies outside block ${quote.blockId}`);
			}
			if (sliceByCodePoints(block.text, quote) !== quote.text) {
				throw new Error(`quote of ${source.key} differs from the text of block ${quote.blockId}`);
			}
			ranges.set(block.id, [...(ranges.get(block.id) ?? []), { key: source.key, start: quote.start, end: quote.end }]);
			located.add(source.key);
		}
	}
	return {
		blocks: blocks.map((block) => ({
			id: block.id,
			page: block.page,
			kind: block.kind,
			segments: segmentsOf(block.text, ranges.get(block.id) ?? [])
		})),
		located: [...located]
	};
}

// --- The upload -----------------------------------------------------------------------------------------------------

/** Where the parse of an upload stands (`resume_documents.parse_status`). */
export type ParseStatus = 'pending' | 'parsed' | 'partial' | 'unsupported_format' | 'failed';

export const PARSE_STATUSES: Record<
	ParseStatus,
	{ label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
> = {
	pending: { label: 'Читаем файл', tone: 'info' },
	parsed: { label: 'Разобрано', tone: 'success' },
	partial: { label: 'Разобрано частично', tone: 'warning' },
	unsupported_format: { label: 'Формат не подошёл', tone: 'danger' },
	failed: { label: 'Не разобрано', tone: 'danger' }
};

// --- Fields and experience entries ----------------------------------------------------------------------------------

export interface ResumeClaimView {
	id: string;
	claimType: string;
	rawText: string;
	polarity: string;
	skillKey: string | null;
	value: unknown;
	quote: ResumeQuote;
	extractor: string;
	candidateReview: string;
	experienceEntryId: string | null;
	sourceKey: string;
}

export interface ResumeEntryView {
	id: string;
	positionTitle: string | null;
	roleKey: string | null;
	organizationName: string | null;
	periodFrom: string | null;
	periodTo: string | null;
	periodFromPrecision: string | null;
	periodToPrecision: string | null;
	isCurrent: boolean;
	periodStatus: string;
	appliedSkillKeys: string[];
	quotes: ResumeQuote[];
	candidateReview: string;
	sourceKey: string;
}

export const CLAIM_TYPES: Record<string, string> = {
	skill_mention: 'Навык',
	experience_period: 'Период работы',
	role_title: 'Должность',
	organization: 'Компания',
	education: 'Образование',
	team_role: 'Роль в команде',
	responsibility_marker: 'Ответственность',
	language_level: 'Язык',
	achievement_mention: 'Достижение'
};

export type ReviewState = 'pending' | 'confirmed' | 'rejected' | 'edited';

export const REVIEW_STATES: Record<
	ReviewState,
	{ label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
> = {
	pending: { label: 'Ждёт проверки', tone: 'neutral' },
	confirmed: { label: 'Подтверждено', tone: 'success' },
	rejected: { label: 'Отклонено', tone: 'danger' },
	edited: { label: 'Исправлено', tone: 'info' }
};

export function reviewState(value: string): ReviewState {
	if (value in REVIEW_STATES) return value as ReviewState;
	throw new Error(`unknown review state ${value}`);
}

const monthFormat = new Intl.DateTimeFormat('ru', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** A stored period date (the first day of its month) as the resume states it: to the month or to the year. */
function periodDate(date: string, precision: string | null): string {
	return precision === 'month' ? monthFormat.format(new Date(`${date}T00:00:00Z`)) : date.slice(0, 4);
}

/** The value of a period field of the correction form: `YYYY-MM` or `YYYY`. */
export function periodInput(date: string | null, precision: string | null): string {
	if (date === null) return '';
	return precision === 'month' ? date.slice(0, 7) : date.slice(0, 4);
}

export function periodText(entry: ResumeEntryView): string | null {
	if (entry.periodFrom === null) return null;
	const from = periodDate(entry.periodFrom, entry.periodFromPrecision);
	if (entry.isCurrent) return `${from} — по настоящее время`;
	return entry.periodTo === null ? `с ${from}` : `${from} — ${periodDate(entry.periodTo, entry.periodToPrecision)}`;
}

/**
 * The fields of the current resume as the pages show them: every claim and experience entry with its parsed quotes and
 * the key it marks the document with, and the document text of this reading with those quotes marked.
 */
export function resumeFields<
	C extends { id: string; quote: unknown },
	E extends { id: string; quotes: unknown }
>(current: {
	claims: readonly C[];
	experience: readonly E[];
	document: { extractionId: string; text: string; blocks: unknown } | null;
}): {
	claims: (Omit<C, 'quote'> & { quote: ResumeQuote; sourceKey: string })[];
	experience: (Omit<E, 'quotes'> & { quotes: ResumeQuote[]; sourceKey: string })[];
	document: DocumentView | null;
} {
	const claims = current.claims.map((claim) => ({
		...claim,
		quote: parseQuote(claim.quote),
		sourceKey: `claim:${claim.id}`
	}));
	const experience = current.experience.map((entry) => ({
		...entry,
		quotes: parseQuotes(entry.quotes),
		sourceKey: `entry:${entry.id}`
	}));
	const sources: QuoteSource[] = [
		...claims.map((claim) => ({ key: claim.sourceKey, quotes: [claim.quote] })),
		...experience.map((entry) => ({ key: entry.sourceKey, quotes: entry.quotes }))
	];
	return {
		claims,
		experience,
		document: current.document === null ? null : documentView(current.document, sources)
	};
}

/** The current resume as the profile shows it: the upload, where its reading stands, the fields and the text. */
export interface ResumeSummaryView {
	upload: { declaredName: string; parseStatus: ParseStatus; uploadedAt: Date; failureMessage: string | null };
	reading: { processingMode: 'model' | 'rules_only' | 'partial' | 'failed' } | null;
	inProgress: boolean;
	claims: ResumeClaimView[];
	experience: ResumeEntryView[];
	document: DocumentView | null;
}

// --- Anchors of the fields --------------------------------------------------------------------------------------------

/** Fields that make up an experience entry itself; the entry shows them as one. */
const ENTRY_FIELDS = new Set(['role_title', 'organization', 'experience_period']);

/** The fields a page lists on their own: the position, company and period of an entry are shown by the entry. */
export function listedClaims<C extends { claimType: string; experienceEntryId: string | null }>(
	claims: readonly C[]
): C[] {
	return claims.filter((claim) => claim.experienceEntryId === null || !ENTRY_FIELDS.has(claim.claimType));
}

/** The id of the element a page shows a field or an experience entry in. */
export function fieldAnchor(sourceKey: string): string {
	return `resume-${sourceKey.replace(':', '-')}`;
}

/**
 * Where a contribution of the resume is shown among the fields of the current resume: the mention itself, otherwise the
 * experience entry it belongs to. `null` when the page does not show it: the fields are listed with the document text
 * only, and a contribution of a resume the category was computed on before this upload is not among them.
 * `located` — the field has a quote in the document text, so the page can select its words there.
 */
export function resumeFieldOf(
	resume: Pick<ResumeSummaryView, 'claims' | 'experience' | 'document'>,
	ref: { claimId: string | null; experienceEntryId: string | null }
): { sourceKey: string; title: string; located: boolean } | null {
	if (resume.document === null) return null;
	const claim = ref.claimId === null ? undefined : listedClaims(resume.claims).find((item) => item.id === ref.claimId);
	const located = new Set(resume.document.located);
	if (claim) {
		return { sourceKey: claim.sourceKey, title: `«${claim.quote.text}»`, located: located.has(claim.sourceKey) };
	}
	const entryId =
		ref.experienceEntryId ??
		(ref.claimId === null ? null : (resume.claims.find((item) => item.id === ref.claimId)?.experienceEntryId ?? null));
	const entry = entryId === null ? undefined : resume.experience.find((item) => item.id === entryId);
	if (entry) {
		return {
			sourceKey: entry.sourceKey,
			title: entry.positionTitle ?? 'опыт работы',
			located: located.has(entry.sourceKey)
		};
	}
	return null;
}
