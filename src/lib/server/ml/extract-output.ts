// The checked answer of the model to `extract` as the product keeps it (docs/domain.md, section 16.1, `ml_results.output`):
// the items that passed every check, each with its quote, in the shape the adapter returns them. A resume keeps the
// refused elements with their reasons; a pasted text keeps the reasons only, as the parse of a pasted text has always
// kept them (`vacancies/text-extract.ts`). The same shapes are read back where a kept answer is given again.
import { z } from 'zod';
import type { ModelInfo } from './adapter';
import { REJECT_REASONS, type Rejected, type RejectReason } from './extract-common';
import { POLARITIES, type QuoteLocation } from './quotes';
import { RESUME_ITEM_KINDS, type ResumeItem } from './resume-extract';
import { LLM_RUNTIMES } from './runtime';
import { SALARY_PERIODS, TAX_BASES, VACANCY_ITEM_KINDS, type VacancyItem } from './vacancy-extract';

export const modelInfoSchema = z.object({
	modelId: z.string(),
	modelRevision: z.string().nullable(),
	runtime: z.enum(LLM_RUNTIMES),
	params: z.record(z.string(), z.unknown())
}) satisfies z.ZodType<ModelInfo>;

const quoteSchema = z.object({
	blockId: z.string(),
	start: z.number(),
	end: z.number(),
	text: z.string()
}) satisfies z.ZodType<QuoteLocation>;

const resumeItemSchema = z.object({
	kind: z.enum(RESUME_ITEM_KINDS),
	group: z.string().nullable(),
	rawText: z.string(),
	polarity: z.enum(POLARITIES),
	modelPolarity: z.enum(POLARITIES),
	periodFrom: z.string().nullable(),
	periodTo: z.string().nullable(),
	organization: z.string().nullable(),
	level: z.string().nullable(),
	quote: quoteSchema
}) satisfies z.ZodType<ResumeItem>;

export const vacancyItemSchema = z.object({
	kind: z.enum(VACANCY_ITEM_KINDS),
	rawText: z.string(),
	polarity: z.enum(POLARITIES).nullable(),
	modelPolarity: z.enum(POLARITIES).nullable(),
	grade: z.object({ min: z.string().nullable(), max: z.string().nullable() }).nullable(),
	value: z.string().nullable(),
	salary: z
		.object({
			min: z.number().nullable(),
			max: z.number().nullable(),
			currency: z.string().nullable(),
			period: z.enum(SALARY_PERIODS).nullable(),
			taxBase: z.enum(TAX_BASES)
		})
		.nullable(),
	quote: quoteSchema
}) satisfies z.ZodType<VacancyItem>;

const rejectedSchema = z.object({ item: z.unknown(), reason: z.enum(REJECT_REASONS) });

/** `resume-extract/v3`. */
export const resumeOutputSchema = z.object({
	items: z.array(resumeItemSchema),
	rejected: z.array(rejectedSchema)
});

export interface ResumeOutput {
	items: ResumeItem[];
	rejected: Rejected[];
}

/** `vacancy-extract/v2`: a pasted vacancy or the text of a hiring need. */
export const vacancyOutputSchema = z.object({
	items: z.array(vacancyItemSchema),
	rejectedReasons: z.array(z.enum(REJECT_REASONS))
});

export interface VacancyOutput {
	items: VacancyItem[];
	rejectedReasons: RejectReason[];
}
