// Parsing the text of a hiring need (docs/domain.md, section 13.10): the employer writes who they look for, the parse
// suggests the fields of the form, each with its quote, and the employer confirms them. The model answers through the
// adapter with the schema of a pasted vacancy (contracts 3.2 `vacancy-extract/v2`: the same reading of role, grade,
// skills, range, format and city, with the same checks of quotes and negations); without the model the deterministic
// rules read the same fields — the path without a GPU is complete, and the parse says which path read it.
// Specializations outside the open ones are not suggested.
import { createHash } from 'node:crypto';
import { GRADE_KEYS, type GradeKey, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { primarySpecializationOfRole } from '$lib/server/categories/roles';
import type { Database } from '$lib/server/db';
import { mlResults } from '$lib/server/db/schema';
import type { ModelAdapter } from '$lib/server/ml/adapter';
import type { Block, QuoteLocation } from '$lib/server/ml/quotes';
import type { VacancyItem } from '$lib/server/ml/vacancy-extract';
import { regionReference } from '$lib/server/regions';
import {
	fieldsFromItems,
	textBlocks,
	VACANCY_SCHEMA_VERSION,
	type VacancyTextFields
} from '$lib/server/vacancies/from-text';
import { roleOfTitle } from '$lib/server/vacancies/normalize';
import { loadVacancyTaxonomy, resolveSkill, vacancyLexicon } from '$lib/server/vacancies/taxonomy';
import { extractVacancyByRules, VACANCY_TEXT_RULES_VERSION } from '$lib/server/vacancies/text-rules';
import { OFFER_WORK_FORMATS } from '$lib/server/invitations/terms';
import { EMPTY_FORM, openSpecializations, type NeedForm } from './form';

/** Version of the reading of a need on top of the rules of a vacancy text: any change of what it suggests is new. */
export const NEED_RULES_VERSION = `need-rules/1+${VACANCY_TEXT_RULES_VERSION}`;

/** A suggested field of the form with the words of the text it rests on. */
export interface ParsedField {
	path: string;
	value: unknown;
	quote: string;
}

/** `hiring_needs.parse`. */
export interface NeedParse {
	mode: 'model' | 'rules';
	ml_result_id: string;
	rules_version: string;
	/** Why the rules read the text: the adapter error code (`disabled`, `timeout`, …). */
	model_failure: string | null;
	fields: ParsedField[];
}

export interface NeedParseDeps {
	db: Database;
	models: Pick<ModelAdapter, 'extract'>;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const quoteText = (quote: QuoteLocation) => quote.text;

function catalogGrade(grade: string | null): GradeKey | null {
	return GRADE_KEYS.find((key) => key === grade) ?? null;
}

/** The suggested form of the read fields: only what the text states, the specialization only among the open ones. */
async function suggestion(
	fields: VacancyTextFields,
	blocks: readonly Block[],
	roleOf: (text: string) => string | null
): Promise<{ form: NeedForm; parsed: ParsedField[] }> {
	const form: NeedForm = { ...EMPTY_FORM, skill_keys: [], nice_skill_keys: [] };
	const parsed: ParsedField[] = [];
	const open = openSpecializations();

	// The role of the title, else the first line whose words name a role; its specialization by the mapping of the
	// module of categories.
	let specialization: { key: SpecializationKey; quote: string } | null = null;
	const byTitle = fields.roleKey === null ? null : primarySpecializationOfRole(fields.roleKey);
	if (byTitle !== null && fields.title) specialization = { key: byTitle, quote: quoteText(fields.title.quote) };
	for (const block of blocks) {
		if (specialization !== null) break;
		const role = roleOf(block.text);
		const key = role === null ? null : primarySpecializationOfRole(role);
		if (key !== null) specialization = { key, quote: block.text };
	}
	if (specialization && open.has(specialization.key)) {
		form.specialization = specialization.key;
		parsed.push({ path: 'specialization', value: specialization.key, quote: specialization.quote });
	}

	const grade = fields.grade && (catalogGrade(fields.grade.value.min) ?? catalogGrade(fields.grade.value.max));
	if (fields.grade && grade) {
		form.grade = grade;
		parsed.push({ path: 'grade', value: grade, quote: quoteText(fields.grade.quote) });
	}

	for (const [path, skills] of [
		['skill_keys', fields.requiredSkills],
		['nice_skill_keys', fields.niceSkills]
	] as const) {
		for (const skill of skills) {
			if (skill.key === null || form.skill_keys.includes(skill.key) || form.nice_skill_keys.includes(skill.key)) {
				continue;
			}
			form[path].push(skill.key);
			parsed.push({ path, value: skill.key, quote: quoteText(skill.quote) });
		}
	}

	const format = OFFER_WORK_FORMATS.find((key) => key === fields.workFormat?.value);
	if (fields.workFormat && format) {
		form.work_format = format;
		parsed.push({ path: 'work_format', value: format, quote: quoteText(fields.workFormat.quote) });
	}

	if (fields.city) {
		const code = (await regionReference()).codeOf(fields.city.value);
		if (code !== undefined) {
			form.region_code = code;
			parsed.push({ path: 'region_code', value: code, quote: quoteText(fields.city.quote) });
		}
	}

	// A range is suggested only in roubles per month with both bounds; the tax base the text does not state is the
	// employer's to choose — the suggestion leaves the range out rather than guessing it.
	const salary = fields.salary?.value;
	if (
		fields.salary &&
		salary &&
		salary.min !== null &&
		salary.max !== null &&
		salary.currency === 'RUB' &&
		(salary.period === 'month' || salary.period === null) &&
		salary.taxBase !== 'unknown'
	) {
		form.salary = { min: salary.min, max: salary.max, currency: 'RUB', period: 'month', tax_base: salary.taxBase };
		parsed.push({ path: 'salary', value: form.salary, quote: quoteText(fields.salary.quote) });
	}
	return { form, parsed };
}

/**
 * Parses the text of a need of the company. The call is interactive: the employer waits. Any model failure gives the
 * rules mode with its reason; the envelope `ml_results` records what happened either way.
 */
export async function parseNeedText(
	deps: NeedParseDeps,
	need: { id: string; companyId: string },
	text: string,
	signal?: AbortSignal
): Promise<{ form: NeedForm; parse: NeedParse }> {
	const blocks = textBlocks(text);
	const taxonomy = await loadVacancyTaxonomy(deps.db);
	const lexicon = vacancyLexicon(taxonomy);
	const response = await deps.models.extract(
		{
			schemaVersion: VACANCY_SCHEMA_VERSION,
			input: { type: 'vacancy', id: need.id, revision: 0 },
			taxonomyVersionId: taxonomy.id,
			blocks
		},
		lexicon,
		{ priority: 'interactive', ...(signal ? { signal } : {}) }
	);
	const toFields = (items: readonly VacancyItem[]) =>
		fieldsFromItems(
			items,
			blocks,
			(raw) => resolveSkill(taxonomy, raw),
			(title) => roleOfTitle(title, taxonomy).key
		);
	const envelope = {
		operation: 'extract' as const,
		inputRef: { type: 'hiring_need', id: need.id, company_id: need.companyId },
		inputSha256: sha256(text),
		inputVersion: '0',
		schemaVersion: VACANCY_SCHEMA_VERSION,
		taxonomyVersionId: taxonomy.id
	};
	let fields: VacancyTextFields;
	let values: typeof mlResults.$inferInsert;
	if (response.ok) {
		fields = toFields(response.value.items);
		values = {
			...envelope,
			model: {
				endpoint_profile: 'extract',
				model_id: response.value.model.modelId,
				model_revision: response.value.model.modelRevision,
				params: response.value.model.params
			},
			processingMode: 'model',
			rejectedItems: response.value.rejected.map((r) => ({ reason: r.reason })),
			latencyMs: response.value.latencyMs
		};
	} else {
		const started = Date.now();
		const checked = extractVacancyByRules(blocks, taxonomy, lexicon);
		fields = toFields(checked.items);
		values = {
			...envelope,
			rulesVersion: NEED_RULES_VERSION,
			processingMode: 'rules_only',
			failure: {
				code: response.error.code,
				retryable: response.error.retryable,
				...(typeof response.error.details?.reason === 'string' ? { reason: response.error.details.reason } : {})
			},
			rejectedItems: checked.rejected.map((r) => ({ reason: r.reason })),
			latencyMs: Date.now() - started
		};
	}
	const [row] = await deps.db.insert(mlResults).values(values).returning({ id: mlResults.id });
	if (!row) throw new Error('ml result was not inserted');
	const { form, parsed } = await suggestion(fields, blocks, (text) => roleOfTitle(text, taxonomy).key);
	return {
		form,
		parse: {
			mode: response.ok ? 'model' : 'rules',
			ml_result_id: row.id,
			rules_version: NEED_RULES_VERSION,
			model_failure: response.ok ? null : response.error.code,
			fields: parsed
		}
	};
}
