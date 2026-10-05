// The form of a hiring need (docs/domain.md, section 13.10): what the employer confirms after the text is parsed —
// specialization and the range of grades of the catalog of categories, required and nice-to-have skills of the taxonomy, the team,
// the work format, the region, a range in roubles per month and whether results of FSP matter. Stored as
// `hiring_needs.form` in this shape, read back through the same schema.
import { z } from 'zod';
import { GRADE_KEYS, gradeOrdinal, SPECIALIZATION_KEYS, type GradeKey } from '$lib/server/assessments/contract/catalog';
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

/**
 * The grades the employer asks for, as a range of the catalog: «Middle» is middle to middle, «Middle–Senior» — middle to
 * senior, «от Junior» — junior to senior.
 */
export const needGradeSchema = z
	.strictObject({ min: z.enum(GRADE_KEYS), max: z.enum(GRADE_KEYS) })
	.refine((range) => gradeOrdinal(range.min) <= gradeOrdinal(range.max), {
		path: ['max'],
		message: 'Верхний грейд ниже нижнего'
	});

export type NeedGrade = z.infer<typeof needGradeSchema>;

/** The grades of a range in their order. */
export function gradesOf(range: NeedGrade): GradeKey[] {
	return GRADE_KEYS.filter(
		(key) => gradeOrdinal(key) >= gradeOrdinal(range.min) && gradeOrdinal(key) <= gradeOrdinal(range.max)
	);
}

export const needFormSchema = z.strictObject({
	specialization: z.enum(SPECIALIZATION_KEYS).optional(),
	grade: needGradeSchema.optional(),
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

/** Parses a stored form; a stored value of the wrong shape is a data error and names the need. */
export function parseNeedForm(needId: string, value: unknown): NeedForm {
	const parsed = needFormSchema.safeParse(value);
	if (!parsed.success) throw new Error(`form of need ${needId} does not match the schema: ${parsed.error.message}`);
	return parsed.data;
}
