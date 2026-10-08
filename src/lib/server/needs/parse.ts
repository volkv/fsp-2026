// Parsing the text of a hiring need (docs/domain.md, section 13.10): the employer writes who they look for, the parse
// suggests the fields of the form, each with its quote, and the employer confirms them. The model answers through the
// adapter with the schema of a pasted vacancy (contracts 3.2 `vacancy-extract/v2`: the same reading of role, grade,
// skills, range, format and city, with the same checks of quotes and negations); without the model the deterministic
// rules read the same fields — the path without a GPU is complete, and the parse says which path read it.
// The role comes from the title; specializations outside the open ones are not suggested; requirements the taxonomy does
// not know are kept by their names.
import { createHash } from 'node:crypto';
import { GRADE_KEYS, type GradeKey, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { openSpecializations } from '$lib/server/assessments/bank-store';
import { specializationsOfRole } from '$lib/server/categories/roles';
import type { Database } from '$lib/server/db';
import { mlResults } from '$lib/server/db/schema';
import { extractModelEnvelope } from '$lib/server/ml/envelope';
import type { VacancyOutput } from '$lib/server/ml/extract-output';
import type { LlmRuntime } from '$lib/server/ml/runtime';
import type { Block, QuoteLocation } from '$lib/server/ml/quotes';
import type { VacancyItem } from '$lib/server/ml/vacancy-extract';
import { placeReference } from '$lib/server/places';
import { fieldsFromItems, textBlocks, type VacancyTextFields } from '$lib/server/vacancies/from-text';
import { extractPastedText, VACANCY_SCHEMA_VERSION, type TextExtractDeps } from '$lib/server/vacancies/text-extract';
import { roleOfTitle, TITLE_WORD } from '$lib/server/taxonomy/roles';
import { loadVacancyTaxonomy, resolveSkill, vacancyLexicon } from '$lib/server/vacancies/taxonomy';
import { extractVacancyByRules, VACANCY_TEXT_RULES_VERSION } from '$lib/server/vacancies/text-rules';
import { OFFER_WORK_FORMATS } from '$lib/server/invitations/terms';
import { EMPTY_FORM, type NeedGrade, type NeedForm } from './form';
import { unrecognizedRequirements } from './requirements';

/** Version of the reading of a need on top of the rules of a vacancy text: any change of what it suggests is new. */
export const NEED_RULES_VERSION = `need-rules/3+${VACANCY_TEXT_RULES_VERSION}`;

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
	/** The model that read the text and its runtime profile (where the text went); `null` — the rules read it. */
	model: { id: string; runtime: LlmRuntime } | null;
	fields: ParsedField[];
}

export interface NeedParseDeps extends TextExtractDeps {
	db: Database;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const quoteText = (quote: QuoteLocation) => quote.text;

function catalogGrade(grade: string | null): GradeKey | null {
	return GRADE_KEYS.find((key) => key === grade) ?? null;
}

/** Words of a grade of the catalog, as a text of a need writes them. */
const GRADE_WORD =
	'(?:intern|стаж\\p{L}*|junior|джун\\p{L}*|младш\\p{L}*|middle|мидл\\p{L}*|senior|сеньор\\p{L}*|синьор\\p{L}*|старш\\p{L}*)';
/** «от Junior», «Junior+», «Junior и выше»: the range has no upper end. */
const OPEN_ABOVE = new RegExp(
	`(?:^|[^\\p{L}])(?:от|from)\\s+${GRADE_WORD}|${GRADE_WORD}\\s*\\+|${GRADE_WORD}\\s+и\\s+выше`,
	'iu'
);
/** «до Middle», «не выше Middle»: the range has no lower end. */
const OPEN_BELOW = new RegExp(`(?:^|[^\\p{L}])(?:до|up\\s+to|не\\s+выше)\\s+${GRADE_WORD}`, 'iu');

/**
 * The range of the catalog a read grade range stands for: grades above the catalog (lead, principal) are its top,
 * senior; a range only above it is none. The words of the quote open a range: «от Junior» — junior to senior, «до
 * Middle» — intern to middle.
 */
function catalogRange(value: { min: string | null; max: string | null }, quote: string): NeedGrade | null {
	const top = GRADE_KEYS[GRADE_KEYS.length - 1] ?? 'senior';
	const [bottom] = GRADE_KEYS;
	const min = catalogGrade(value.min);
	const max = catalogGrade(value.max) ?? (value.max === null ? min : top);
	if (min === null || max === null) return null;
	return {
		min: OPEN_BELOW.test(quote) && min === max ? bottom : min,
		max: OPEN_ABOVE.test(quote) && min === max ? top : max
	};
}

/** The suggested form of the read fields: only what the text states, the specialization only among the open ones. */
async function suggestion(
	fields: VacancyTextFields,
	blocks: readonly Block[],
	roleOf: (text: string) => string | null,
	open: ReadonlySet<SpecializationKey>
): Promise<{ form: NeedForm; parsed: ParsedField[] }> {
	const form: NeedForm = { ...EMPTY_FORM, skill_keys: [], nice_skill_keys: [] };
	const parsed: ParsedField[] = [];

	// The role of the title, else of a line with a job word («Ищем в команду инженера данных»): a line of a stack or of a
	// sentence never names it — «Python» there is a tool, not the position. A role mapping to specializations gives the
	// specialization when it is one; a role of several (fullstack) leaves the choice to the categories of the role; a
	// role no test checks (data engineer, systems analyst) stays the role of the need without a specialization.
	let role: { key: string; quote: string } | null =
		fields.roleKey !== null && fields.title ? { key: fields.roleKey, quote: quoteText(fields.title.quote) } : null;
	for (const block of blocks) {
		if (role !== null) break;
		if (!TITLE_WORD.test(block.text)) continue;
		const key = roleOf(block.text);
		if (key !== null) role = { key, quote: block.text };
	}
	if (role !== null) {
		form.role_key = role.key;
		parsed.push({ path: 'role_key', value: role.key, quote: role.quote });
		const specializations = specializationsOfRole(role.key);
		const [only] = specializations;
		if (specializations.length === 1 && only !== undefined && open.has(only)) {
			form.specialization = only;
			parsed.push({ path: 'specialization', value: only, quote: role.quote });
		}
	}

	const range = fields.grade && catalogRange(fields.grade.value, quoteText(fields.grade.quote));
	if (fields.grade && range) {
		form.grade = range;
		parsed.push({ path: 'grade', value: range, quote: quoteText(fields.grade.quote) });
	}

	for (const [path, skills] of [
		['skill_keys', fields.requiredSkills],
		['nice_skill_keys', fields.niceSkills]
	] as const) {
		for (const skill of skills) {
			if (skill.key === null) continue;
			if (form.skill_keys.includes(skill.key) || form.nice_skill_keys.includes(skill.key)) continue;
			form[path].push(skill.key);
			parsed.push({ path, value: skill.key, quote: quoteText(skill.quote) });
		}
	}

	// Requirements no skill of the taxonomy names: the model's skills without a key and the items of the lists of
	// requirements no alias read. Kept by their names for the employer to confirm — never dropped, never replaced by a
	// broader skill.
	const other: { name: string; requirement: 'required' | 'nice'; quote: string }[] = [
		...[...fields.requiredSkills, ...fields.niceSkills]
			.filter((skill) => skill.key === null)
			.map((skill) => ({
				name: skill.raw.trim(),
				requirement: fields.niceSkills.includes(skill) ? ('nice' as const) : ('required' as const),
				quote: quoteText(skill.quote)
			})),
		...unrecognizedRequirements(
			blocks,
			[...fields.requiredSkills, ...fields.niceSkills, ...fields.negatedSkills].map((skill) => skill.raw)
		)
	];
	const seen = new Set<string>();
	for (const item of other) {
		const folded = item.name.toLowerCase();
		if (item.name === '' || seen.has(folded)) continue;
		seen.add(folded);
		const path = item.requirement === 'nice' ? 'other_nice_skills' : 'other_skills';
		(form[path] ??= []).push(item.name);
		parsed.push({ path, value: item.name, quote: item.quote });
	}

	const format = OFFER_WORK_FORMATS.find((key) => key === fields.workFormat?.value);
	if (fields.workFormat && format) {
		form.work_format = format;
		parsed.push({ path: 'work_format', value: format, quote: quoteText(fields.workFormat.quote) });
	}

	// The region: the city the reading found — one outside the reference (Ташкент) gives none — else the first place a
	// line names, a city in any case or a region by its name, through the reference of places.
	const places = await placeReference();
	let place: { code: string; quote: string } | null = null;
	if (fields.city) {
		const found = places.find(fields.city.value);
		if (found) place = { code: found.regionCode, quote: quoteText(fields.city.quote) };
	} else {
		for (const block of blocks) {
			const found = places.find(block.text);
			if (found) {
				place = { code: found.regionCode, quote: block.text };
				break;
			}
		}
	}
	if (place !== null) {
		form.region_code = place.code;
		parsed.push({ path: 'region_code', value: place.code, quote: place.quote });
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
 * Parses the text of a need of the company. The call is interactive: the employer waits; the same text parsed again
 * gets the answer the model gave (`extractPastedText`). Any model failure gives the rules mode with its reason; the
 * envelope `ml_results` records what happened either way.
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
	const inputSha256 = sha256(text);
	const response = await extractPastedText(
		deps,
		{ companyId: need.companyId, inputSha256, inputId: need.id, taxonomyVersionId: taxonomy.id, blocks },
		lexicon,
		signal ? { signal } : {}
	);
	const toFields = (items: readonly VacancyItem[]) =>
		fieldsFromItems(
			items,
			blocks,
			(raw) => resolveSkill(taxonomy, raw),
			(title) => roleOfTitle(title, taxonomy.roleNames)
		);
	const envelope = {
		operation: 'extract' as const,
		inputRef: { type: 'hiring_need', id: need.id, company_id: need.companyId },
		inputSha256,
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
			model: extractModelEnvelope(response.value.model, response.value.stored),
			processingMode: 'model',
			rejectedItems: response.value.rejectedReasons.map((reason) => ({ reason })),
			output: {
				items: response.value.items,
				rejectedReasons: response.value.rejectedReasons
			} satisfies VacancyOutput,
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
	const { form, parsed } = await suggestion(
		fields,
		blocks,
		(text) => roleOfTitle(text, taxonomy.roleNames),
		await openSpecializations(deps.db)
	);
	return {
		form,
		parse: {
			mode: response.ok ? 'model' : 'rules',
			ml_result_id: row.id,
			rules_version: NEED_RULES_VERSION,
			model_failure: response.ok ? null : response.error.code,
			model: response.ok ? { id: response.value.model.modelId, runtime: response.value.model.runtime } : null,
			fields: parsed
		}
	};
}
