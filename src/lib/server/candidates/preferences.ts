// `candidates.preferences` (docs/domain.md, section 7.1): the one schema of the stored form — work formats, employment
// forms, region, relocation and the salary expectation. Keys are snake_case like every stored jsonb. A writer of the
// profile validates with it before storing; readers parse with it.
import { z } from 'zod';
import { SALARY_PERIODS, SALARY_TAX_BASES } from '$lib/server/db/schema/_columns';
import type { SalaryTerms } from '$lib/server/salary/compare';

const money = z.int().nonnegative();

export const salaryExpectationSchema = z
	.strictObject({
		min: money.nullable(),
		max: money.nullable(),
		currency: z.string().regex(/^[A-Z]{3}$/),
		period: z.enum(SALARY_PERIODS),
		tax_base: z.enum(SALARY_TAX_BASES)
	})
	.refine((s) => s.min === null || s.max === null || s.min <= s.max, 'min must not exceed max');

export const candidatePreferencesSchema = z.object({
	/** Keys of the `work_format` dimension of the taxonomy. */
	work_formats: z.array(z.string().min(1)).optional(),
	employment_forms: z.array(z.string().min(1)).optional(),
	/** Region code: the catalog shows the region, never the city (domain 14). */
	region_code: z.string().min(1).optional(),
	relocation: z.boolean().optional(),
	salary_expectation: salaryExpectationSchema.optional()
});

export type CandidatePreferences = z.infer<typeof candidatePreferencesSchema>;

/** Parses stored preferences; a stored value of the wrong shape is a data error and names the candidate. */
export function parsePreferences(candidateId: string, value: unknown): CandidatePreferences {
	const parsed = candidatePreferencesSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`preferences of candidate ${candidateId} do not match the schema: ${parsed.error.message}`);
	}
	return parsed.data;
}

export function salaryExpectation(preferences: CandidatePreferences): SalaryTerms | null {
	const expectation = preferences.salary_expectation;
	if (!expectation) return null;
	return {
		min: expectation.min,
		max: expectation.max,
		currency: expectation.currency,
		period: expectation.period,
		taxBase: expectation.tax_base
	};
}
