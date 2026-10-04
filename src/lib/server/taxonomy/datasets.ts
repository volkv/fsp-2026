// Schemas of the taxonomy source files in `taxonomy/` (docs/domain.md sections 9, 11, 12).
// Imported by plain Node (scripts/seed-taxonomy.ts): relative imports with extensions, erasable syntax only.
import { z } from 'zod';
import { categorizationParamsSchema, MARKERS, SKILL_KINDS } from '../categorization/params.ts';
import { matchRulesetParamsSchema } from '../matching/params.ts';

/** Discipline codes of the FSP adapter (docs/contracts.md 1.3). */
const DISCIPLINES = ['algorithmic', 'product', 'uas', 'robotics', 'infosec'] as const;

const COMPETITION_LEVELS = [
	'world_championship',
	'european_championship',
	'international_ekp',
	'russian_championship',
	'russian_cup',
	'russian_youth_championship',
	'all_russian_ekp',
	'all_russian_sport_event',
	'universiade',
	'federal_district',
	'interregional_ekp',
	'regional_championship',
	'regional_cup',
	'regional_youth',
	'regional_other',
	'municipal',
	'accredited',
	'unofficial'
] as const;
const STAGES = ['qualifier', 'final', 'single'] as const;
const AGE_GROUPS = ['boys_girls_u15', 'juniors_u19', 'juniors_u26', 'adults'] as const;
const EVSK_RANKS = ['MS', 'KMS', 'I', 'II', 'III', 'Y1', 'Y2', 'Y3'] as const;
const QUALIFICATION_RANKS = ['ZMS', 'MSMK', ...EVSK_RANKS] as const;
const FSP_LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5'] as const;
const FACT_SOURCES = ['fsp', 'platform_test', 'codeforces', 'github'] as const;
const FACT_TYPES = [
	'competition_result',
	'qualification',
	'national_team',
	'platform_rating',
	'test_score',
	'repo_languages'
] as const;
const SALARY_PERIODS = ['month', 'year', 'hour', 'project'] as const;
const SALARY_TAX_BASES = ['gross', 'net', 'unknown'] as const;
const SALARY_METHODS = ['observed_median', 'estimated_stack_adjustment'] as const;

const text = z.string().regex(/\S/, 'must not be blank');
const key = z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be a snake_case key');
const digits = z.string().regex(/^\d+$/, 'must be a numeric id');
/** camelCase name of a payload field. */
const fieldName = z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'must be a camelCase field name');
const isoDate = z.iso.date();
/** `YYYY.MM.N` — label of a taxonomy release and of a dataset version. */
const versionLabel = z.string().regex(/^\d{4}\.(0[1-9]|1[0-2])\.[1-9]\d*$/, 'must look like 2026.09.1');

/** A number the database keeps exactly: `numeric(p, s)` rounds anything finer than `scale` decimals. */
function decimal(scale: number) {
	return z
		.number()
		.refine((value) => Number(value.toFixed(scale)) === value, { message: `must have at most ${scale} decimals` });
}
const weight = decimal(3).min(0).max(1);

const source = z.strictObject({
	title: text,
	url: z.url({ protocol: /^https?$/ }).optional(),
	retrievedAt: isoDate,
	license: text.optional()
});
const sources = z.array(source).min(1);
const meta = z.strictObject({ version: versionLabel, description: text, sources });

const release = z.strictObject({ label: versionLabel, description: text });

/** A list of distinct codes. */
function codes(code: z.ZodString) {
	return z
		.array(code)
		.refine((values) => new Set(values).size === values.length, { message: 'must not repeat a code' });
}

const roles = z.strictObject({
	meta,
	families: z.record(key, text),
	roles: z.array(
		z.strictObject({
			key,
			family: key,
			nameRu: text,
			coreSkillGroups: z.array(z.array(key).min(1)).min(1),
			typicalSkills: z.array(key),
			// External classifier codes, main code first; an empty list — the classifier has no such role.
			hhRoleIds: codes(digits),
			habrSpecs: codes(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'must be a Habr Career specialization')),
			profStandards: codes(z.string().regex(/^\d{2}\.\d{3}$/, 'must be a professional standard code like 06.001'))
		})
	)
});

const skills = z.strictObject({
	meta,
	skills: z.array(
		z.strictObject({
			key,
			kind: z.enum(SKILL_KINDS),
			parentKey: key.nullable(),
			name: text,
			hhId: digits.nullable(),
			habrId: digits.nullable(),
			soTag: text.nullable(),
			aliases: z.array(text)
		})
	)
});

const grades = z.strictObject({
	meta,
	grades: z.array(z.strictObject({ key, ordinal: z.int().min(0), name: text }))
});

const workFormats = z.strictObject({
	meta,
	dimensions: z.record(key, z.array(z.strictObject({ key, name: text })).min(1))
});

const projectionTargets = z
	.strictObject({
		skill: z.record(key, weight).optional(),
		role: z.record(key, weight).optional(),
		marker: z.partialRecord(z.enum(MARKERS), weight).optional()
	})
	.refine((t) => Object.keys({ ...t.skill, ...t.role, ...t.marker }).length > 0, { message: 'no targets' });

const fspProjection = z.strictObject({
	meta,
	ruleGroups: z.array(
		z
			.strictObject({
				discipline: z.enum(DISCIPLINES),
				appliesTo: z.enum(['individual', 'team', 'any']),
				attestation: z.enum(['direct', 'derived']),
				requiresSpecialization: key.nullable(),
				targets: projectionTargets
			})
			// A team result never confirms a skill directly (domain 9.3).
			.refine((g) => g.attestation === 'derived' || g.appliesTo === 'individual', {
				message: 'direct attestation applies to individual results only'
			})
			// A role or a marker is a conclusion drawn from a result, never its direct content.
			.refine((g) => g.attestation === 'derived' || (!g.targets.role && !g.targets.marker), {
				message: 'roles and markers are derived only'
			})
	)
});

const placeRange = z
	.strictObject({ rank: z.enum(EVSK_RANKS), fromPlace: z.int().min(1), toPlace: z.int().min(1) })
	.refine((r) => r.fromPlace <= r.toPlace, { message: 'fromPlace must not exceed toPlace' });

const formatFactors = z
	.strictObject({
		rows: z.array(z.strictObject({ stage: z.enum(STAGES), online: z.boolean(), factor: weight })),
		unknown: weight
	})
	.superRefine((value, ctx) => {
		const seen = new Map<string, number>();
		for (const row of value.rows) {
			const id = `${row.stage}/${String(row.online)}`;
			if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `duplicate format ${id}` });
			seen.set(id, row.factor);
		}
		for (const stage of STAGES) {
			for (const online of [false, true]) {
				if (!seen.has(`${stage}/${String(online)}`)) {
					ctx.addIssue({ code: 'custom', message: `missing format ${stage}/${String(online)}` });
				}
			}
		}
		// An unknown format counts as an online qualifier: the conservative end (domain 9.3).
		if (seen.get('qualifier/true') !== value.unknown) {
			ctx.addIssue({ code: 'custom', message: 'unknown factor must equal the online qualifier factor' });
		}
		// An on-site final weighs more than an online qualifier (domain 9.3).
		const onsiteFinal = seen.get('final/false');
		if (onsiteFinal !== undefined && onsiteFinal <= value.unknown) {
			ctx.addIssue({ code: 'custom', message: 'an on-site final must weigh more than an online qualifier' });
		}
	});

const fspStrength = z.strictObject({
	meta,
	evskNorm: z.strictObject({
		norm: z.strictObject({
			document: text,
			appendix: text,
			edition: isoDate,
			registration: text,
			url: z.url({ protocol: /^https?$/ }),
			sameContentAs: text
		}),
		minAge: z.record(z.enum(EVSK_RANKS), z.int().min(0)),
		eligibleStages: z.array(z.enum(STAGES)).min(1),
		u15Disciplines: z.array(z.enum(DISCIPLINES)),
		placeOverlap: z.literal('first_listed_rank'),
		rows: z.array(
			z.strictObject({
				level: z.enum(COMPETITION_LEVELS),
				ageGroup: z.enum(AGE_GROUPS),
				ranges: z.array(placeRange).min(1)
			})
		)
	}),
	rankStrength: z.record(z.enum([...QUALIFICATION_RANKS, 'participation']), weight),
	formatFactors,
	unknownRoleFactor: weight,
	recencyHalfLifeYears: decimal(2).positive().max(999)
});

const levelCriterion = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('rank'),
		minRank: z.enum(EVSK_RANKS),
		basis: z.array(z.enum(['qualification', 'evsk_indicator'])).min(1)
	}),
	z.strictObject({ kind: z.literal('national_team'), squads: z.array(z.enum(['main', 'reserve'])).min(1) }),
	z.strictObject({ kind: z.literal('participation'), resultStatuses: z.array(z.literal('official')).min(1) })
]);

const fspLevels = z.strictObject({
	meta,
	levels: z.array(
		z.strictObject({
			level: z.enum(FSP_LEVELS),
			criteria: z.strictObject({ anyOf: z.array(levelCriterion).min(1) })
		})
	)
});

/** Roles of an athlete in a team result (docs/contracts.md 1.3); `unknown` — the source did not pass the role. */
const TEAM_ROLES = ['captain', 'athlete', 'reserve', 'trainer', 'unknown'] as const;

/**
 * What a receipt does not assert (docs/domain.md 9.6): `all` — in every receipt of the template; `team` and
 * `individual` — in a receipt of a team or a personal competition result; `byRole` — in a receipt of a team result of
 * the athlete in that role. The column `receipt_templates.does_not_assert` holds it as is.
 */
export const receiptLimitsSchema = z.strictObject({
	all: z.array(text).min(1),
	team: z.array(text),
	individual: z.array(text),
	byRole: z.partialRecord(z.enum(TEAM_ROLES), z.array(text).min(1))
});

export type ReceiptLimits = z.output<typeof receiptLimitsSchema>;

const receiptTemplates = z.strictObject({
	meta,
	templates: z.array(
		z.strictObject({
			source: z.enum(FACT_SOURCES),
			factType: z.enum(FACT_TYPES),
			asserts: z.strictObject({ generalized: z.array(fieldName).min(1), exact: z.array(fieldName).min(1) }),
			doesNotAssert: receiptLimitsSchema
		})
	)
});

const money = z.int().min(0).nullable();
const salaryReferences = z.strictObject({
	meta,
	source: key,
	collectedAt: isoDate,
	currency: z.string().regex(/^[A-Z]{3}$/),
	period: z.enum(SALARY_PERIODS),
	taxBase: z.enum(SALARY_TAX_BASES),
	geography: text,
	references: z.array(
		z
			.strictObject({
				roleKey: key,
				gradeKey: key.nullable(),
				skillKey: key.nullable(),
				median: money,
				p25: money,
				p75: money,
				sampleSize: z.int().min(0),
				method: z.enum(SALARY_METHODS)
			})
			.refine(
				(r) =>
					(r.p25 === null || r.median === null || r.p25 <= r.median) &&
					(r.median === null || r.p75 === null || r.median <= r.p75),
				{ message: 'quantiles must be ordered' }
			)
			// A stack premium is an estimate for one role × grade × skill, never an observation (domain 12.5).
			.refine(
				(r) =>
					r.method === 'observed_median'
						? r.skillKey === null
						: r.skillKey !== null && r.gradeKey !== null && r.p25 === null && r.p75 === null,
				{ message: 'observed rows have no skill; estimated rows have a grade and a skill and no quantiles' }
			)
	)
});

const rulesetMeta = z.strictObject({ description: text, sources });

/** Parameters are validated by the calculation that reads them, so a release carries only what it can run. */
const categorizationRuleset = z.strictObject({
	meta: rulesetMeta,
	version: z.int().min(1),
	params: categorizationParamsSchema
});

const matchRuleset = z.strictObject({
	meta: rulesetMeta,
	version: z.int().min(1),
	params: matchRulesetParamsSchema
});

/** Source files of one taxonomy release, relative to the `taxonomy/` directory. */
export const DATASET_FILES = {
	release: 'release.json',
	roles: 'roles.json',
	skills: 'skills.json',
	grades: 'grades.json',
	workFormats: 'work-formats.json',
	fspProjection: 'fsp-projection.json',
	fspStrength: 'fsp-strength.json',
	fspLevels: 'fsp-levels.json',
	receiptTemplates: 'receipt-templates.json',
	salaryReferences: 'salary-references.json',
	categorizationRuleset: 'categorization-ruleset.json',
	matchRuleset: 'match-ruleset.json'
} as const;

export const datasetSchemas = {
	release,
	roles,
	skills,
	grades,
	workFormats,
	fspProjection,
	fspStrength,
	fspLevels,
	receiptTemplates,
	salaryReferences,
	categorizationRuleset,
	matchRuleset
} satisfies Record<keyof typeof DATASET_FILES, z.ZodType>;

export type DatasetName = keyof typeof DATASET_FILES;
export type TaxonomyDatasets = { [K in DatasetName]: z.output<(typeof datasetSchemas)[K]> };
