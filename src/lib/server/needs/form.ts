// The form of a hiring need (docs/domain.md, section 13.10): what the employer confirms after the text is parsed —
// specialization and grade of the catalog of categories, required and nice-to-have skills of the taxonomy, the team,
// the work format, the region, a range in roubles per month and whether results of FSP matter. Stored as
// `hiring_needs.form` in this shape, read back through the same schema.
import { z } from 'zod';
import {
	CATALOG,
	GRADE_KEYS,
	SPECIALIZATION_KEYS,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import { OFFER_WORK_FORMATS } from '$lib/server/invitations/terms';

const skillKey = z.string().regex(/^[a-z0-9_]+$/u);

export const NEED_TEXT_MAX = 5000;
export const NEED_TEAM_MAX = 500;

export const needSalarySchema = z
	.strictObject({
		min: z.int().positive(),
		max: z.int().positive(),
		currency: z.literal('RUB'),
		period: z.literal('month'),
		tax_base: z.enum(['gross', 'net'])
	})
	.refine((salary) => salary.min <= salary.max, { path: ['max'], message: 'Верхняя граница ниже нижней' });

export const needFormSchema = z.strictObject({
	specialization: z.enum(SPECIALIZATION_KEYS).optional(),
	grade: z.enum(GRADE_KEYS).optional(),
	skill_keys: z.array(skillKey).max(30),
	nice_skill_keys: z.array(skillKey).max(30),
	team: z.string().trim().min(1).max(NEED_TEAM_MAX).optional(),
	work_format: z.enum(OFFER_WORK_FORMATS).optional(),
	region_code: z.string().min(1).optional(),
	salary: needSalarySchema.optional(),
	fsp_relevant: z.boolean().optional()
});

export type NeedForm = z.infer<typeof needFormSchema>;

export const EMPTY_FORM: NeedForm = { skill_keys: [], nice_skill_keys: [] };

/**
 * Specializations a need may name: switched on in the catalog. The released bank of each (domain 10.5) is the other
 * half of `specializationOpen`; it joins here with the module of test releases.
 */
export function openSpecializations(): ReadonlySet<SpecializationKey> {
	return new Set(CATALOG.specializations.filter((s) => s.availability === 'enabled').map((s) => s.key));
}

/** Parses a stored form; a stored value of the wrong shape is a data error and names the need. */
export function parseNeedForm(needId: string, value: unknown): NeedForm {
	const parsed = needFormSchema.safeParse(value);
	if (!parsed.success) throw new Error(`form of need ${needId} does not match the schema: ${parsed.error.message}`);
	return parsed.data;
}
