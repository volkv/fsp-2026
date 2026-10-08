// A vacancy from pasted text (CONCEPT, promise 4; contracts 3.2 `vacancy-extract/v2`; domain 13.1): the text is split
// into paragraphs, the model suggests fields with a quote from the text for each, the suggestion is recorded as an
// `ml_results` envelope, and the employer fills in what is missing and saves the draft (`createOwnVacancy` with
// `fromText`). The model never decides: skills are normalized by the taxonomy rules, a negated skill is not a
// requirement, a field the text does not state stays empty. Without the model the deterministic rules read the same
// fields with quotes (`text-rules.ts`), and the product says so: the employer checks what the rules found. The draft
// also says where the suggested salary range stands against the market of its category (domain 12.5), so the
// employer sees it before saving; `unsavedVacancyOf` gives the draft to the estimate of its pool (`pool.ts`).
import { createHash } from 'node:crypto';
import { requireAdmission } from '$lib/server/companies/gate';
import type { Database } from '$lib/server/db';
import { mlResults } from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import { vacancyMarketPosition, type VacancyForPosition, type VacancyMarketPosition } from '$lib/server/market/read';
import { extractModelEnvelope } from '$lib/server/ml/envelope';
import type { Block, QuoteLocation } from '$lib/server/ml/quotes';
import type { VacancyItem } from '$lib/server/ml/vacancy-extract';
import { roleOfTitle } from '$lib/server/taxonomy/roles';
import { invalid } from './errors';
import type { UnsavedVacancy } from './pool';
import { checkVacancyText, type TextCheck } from './text-check';
import { extractVacancyByRules, VACANCY_TEXT_RULES_VERSION } from './text-rules';
import { loadVacancyTaxonomy, resolveSkill, vacancyLexicon } from './taxonomy';
import { extractPastedText, VACANCY_SCHEMA_VERSION, type TextExtractDeps } from './text-extract';

export const VACANCY_TEXT_MAX_LENGTH = 20_000;

export interface VacancyTextDeps extends TextExtractDeps {
	db: Database;
}

interface Quoted<T> {
	value: T;
	quote: QuoteLocation;
}

export interface VacancyTextSkill {
	/** `null` — the taxonomy does not know the skill; the employer picks one or drops it. */
	key: string | null;
	raw: string;
	quote: QuoteLocation;
}

export interface VacancyTextFields {
	title: Quoted<string> | null;
	/** Role by the title rules; `null` — not recognized. */
	roleKey: string | null;
	grade: Quoted<{ min: string | null; max: string | null }> | null;
	requiredSkills: VacancyTextSkill[];
	niceSkills: VacancyTextSkill[];
	/** Skills the text says are not needed («Java не требуется»): shown, never a requirement. */
	negatedSkills: VacancyTextSkill[];
	salary: Quoted<{
		min: number | null;
		max: number | null;
		currency: string | null;
		period: 'month' | 'year' | 'hour' | 'project' | null;
		taxBase: 'gross' | 'net' | 'unknown';
	}> | null;
	workFormat: Quoted<string> | null;
	employmentForm: Quoted<string> | null;
	contractTypes: Quoted<string>[];
	city: Quoted<string> | null;
}

/** Fields of `ownVacancyInputSchema` the employer still has to fill before the draft can be saved. */
export type MissingField =
	| 'title'
	| 'roleKey'
	| 'grade'
	| 'workFormat'
	| 'employmentForm'
	| 'contractTypes'
	| 'salary.bounds'
	| 'salary.currency'
	| 'salary.period'
	| 'salary.taxBase';

export interface VacancyTextDraft {
	/** The id the saved vacancy gets. */
	vacancyId: string;
	/** `draft_ml_result_id` of the saved vacancy. */
	mlResultId: string;
	/** `model` — fields suggested by the model; `rules` — the model is off or failed, the rules read the fields. */
	mode: 'model' | 'rules';
	/** Why the rules read the text: the adapter error code (`disabled`, `timeout`, …). */
	modelFailure: string | null;
	blocks: { id: string; text: string }[];
	fields: VacancyTextFields;
	missing: MissingField[];
	/** The pasted text checked for discriminatory requirements before anything is saved. */
	textCheck: TextCheck;
	/** The suggested range against the market of the category of the suggested role (domain 12.8, 12.10). */
	marketPosition: VacancyMarketPosition;
	taxonomyVersionId: string;
}

/** Paragraphs of the text as extract blocks; an empty line or a line break separates them. */
export function textBlocks(text: string): { id: string; text: string }[] {
	return text
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line !== '')
		.map((line, index) => ({ id: `p${index + 1}`, text: line }));
}

const EMPTY_FIELDS: VacancyTextFields = {
	title: null,
	roleKey: null,
	grade: null,
	requiredSkills: [],
	niceSkills: [],
	negatedSkills: [],
	salary: null,
	workFormat: null,
	employmentForm: null,
	contractTypes: [],
	city: null
};

/** A word that offers a choice between two skills: «C++ или Python», «Go либо Rust», «Go or Rust». */
const CHOICE_WORD = String.raw`(?:или|либо|or)`;
/** What joins two alternative names inside one mention: a choice word or a slash («Go/Rust»). */
const ALTERNATIVE_JOIN = new RegExp(String.raw`\s+${CHOICE_WORD}\s+|\s*\/\s*`, 'iu');
const HAS_CHOICE_WORD = new RegExp(String.raw`\s${CHOICE_WORD}\s`, 'iu');
/** The text between two skill quotes that makes them a choice: «C++ или Python», «Go, либо Rust». */
const CHOICE_BETWEEN = new RegExp(String.raw`^\s*,?\s*${CHOICE_WORD}\s+$`, 'iu');

type SkillItem = VacancyItem & { kind: 'required_skill' | 'nice_skill' };

const isSkill = (item: VacancyItem): item is SkillItem => item.kind === 'required_skill' || item.kind === 'nice_skill';

/**
 * Skill items with the alternatives of the text marked. One mention naming alternatives that the taxonomy does not
 * know as one skill — «C++ или Python», «Go/Rust» — is a skill per name, each with the quote of the mention; a name
 * the taxonomy knows with its slash («CI/CD», «PL/SQL») stays one. A skill is a choice when the text offers it as one of
 * several by a choice word, in one mention or between the quotes of two items of one block. A slash alone makes no
 * choice: «HTML/CSS», «C#/.NET» are named together as often as instead of each other.
 */
function skillAlternatives(
	items: readonly VacancyItem[],
	blocks: readonly Block[],
	resolve: (raw: string) => string | null
): Map<VacancyItem, { rawText: string; choice: boolean }[]> {
	const parts = new Map<VacancyItem, { rawText: string; choice: boolean }[]>();
	for (const item of items.filter(isSkill)) {
		const names = resolve(item.rawText) === null ? item.rawText.split(ALTERNATIVE_JOIN).map((n) => n.trim()) : [];
		const split = names.length > 1 && names.every((name) => name !== '');
		const choice = split && HAS_CHOICE_WORD.test(item.rawText);
		parts.set(item, split ? names.map((rawText) => ({ rawText, choice })) : [{ rawText: item.rawText, choice: false }]);
	}
	const textOf = new Map(blocks.map((block) => [block.id, Array.from(block.text)]));
	const byBlock = Map.groupBy(items.filter(isSkill), (item) => item.quote.blockId);
	for (const [blockId, inBlock] of byBlock) {
		const text = textOf.get(blockId);
		if (!text) continue;
		const ordered = inBlock.toSorted((a, b) => a.quote.start - b.quote.start);
		ordered.forEach((left, index) => {
			const right = ordered[index + 1];
			if (!right || right.quote.start < left.quote.end) return;
			if (!CHOICE_BETWEEN.test(text.slice(left.quote.end, right.quote.start).join(''))) return;
			for (const side of [left, right]) {
				parts.set(
					side,
					(parts.get(side) ?? []).map((part) => ({ ...part, choice: true }))
				);
			}
		});
	}
	return parts;
}

/**
 * Fields of the checked items of one text. The vacancy has no «one of» requirement (domain 13.1: required and nice
 * skill keys), so skills the text offers as a choice are wishes: requiring each would demand what the text does not,
 * and a candidate with one of them would miss the other requirement.
 */
export function fieldsFromItems(
	items: readonly VacancyItem[],
	blocks: readonly Block[],
	resolve: (raw: string) => string | null,
	role: (title: string) => string | null
): VacancyTextFields {
	const fields: VacancyTextFields = {
		...EMPTY_FIELDS,
		requiredSkills: [],
		niceSkills: [],
		negatedSkills: [],
		contractTypes: []
	};
	const seen = new Set<string>();
	const alternatives = skillAlternatives(items, blocks, resolve);
	for (const item of items) {
		switch (item.kind) {
			case 'role_title':
				fields.title ??= { value: item.rawText.trim(), quote: item.quote };
				break;
			case 'grade':
				if (item.grade) fields.grade ??= { value: item.grade, quote: item.quote };
				break;
			case 'required_skill':
			case 'nice_skill': {
				for (const { rawText, choice } of alternatives.get(item) ?? []) {
					const skill = { key: resolve(rawText), raw: rawText, quote: item.quote };
					const id = skill.key ?? `raw:${rawText.toLowerCase()}`;
					if (seen.has(id)) continue;
					seen.add(id);
					if (item.polarity === 'negated') fields.negatedSkills.push(skill);
					else if (item.kind === 'required_skill' && item.polarity === 'asserted' && !choice) {
						fields.requiredSkills.push(skill);
					}
					// An uncertain requirement («желательно», «будет плюсом») and one of a choice are wishes, not conditions.
					else fields.niceSkills.push(skill);
				}
				break;
			}
			case 'salary':
				if (item.salary) fields.salary ??= { value: item.salary, quote: item.quote };
				break;
			case 'work_format':
				if (item.value !== null) fields.workFormat ??= { value: item.value, quote: item.quote };
				break;
			case 'employment_form':
				if (item.value !== null) fields.employmentForm ??= { value: item.value, quote: item.quote };
				break;
			case 'contract_type':
				if (item.value !== null && !fields.contractTypes.some((c) => c.value === item.value)) {
					fields.contractTypes.push({ value: item.value, quote: item.quote });
				}
				break;
			case 'city':
				fields.city ??= { value: item.rawText.trim(), quote: item.quote };
				break;
		}
	}
	fields.roleKey = fields.title ? role(fields.title.value) : null;
	return fields;
}

export function missingFields(fields: VacancyTextFields): MissingField[] {
	const missing: MissingField[] = [];
	if (!fields.title) missing.push('title');
	if (!fields.roleKey) missing.push('roleKey');
	if (!fields.grade || fields.grade.value.min === null || fields.grade.value.max === null) missing.push('grade');
	if (!fields.workFormat) missing.push('workFormat');
	if (!fields.employmentForm) missing.push('employmentForm');
	if (fields.contractTypes.length === 0) missing.push('contractTypes');
	const salary = fields.salary?.value;
	if (!salary || salary.min === null || salary.max === null) missing.push('salary.bounds');
	if (!salary?.currency) missing.push('salary.currency');
	if (!salary?.period) missing.push('salary.period');
	if (!salary || salary.taxBase === 'unknown') missing.push('salary.taxBase');
	return missing;
}

/**
 * The vacancy the market position is computed for: the suggested role, grade and range.
 * A range the text does not state has no bounds, so it is «не сравнимо», never compared as zero.
 */
export function positionInput(fields: VacancyTextFields): VacancyForPosition {
	const salary = fields.salary?.value;
	return {
		roleKey: fields.roleKey,
		gradeMin: fields.grade?.value.min ?? null,
		gradeMax: fields.grade?.value.max ?? null,
		salary: salary
			? { min: salary.min, max: salary.max, currency: salary.currency, period: salary.period, taxBase: salary.taxBase }
			: { min: null, max: null, currency: null, period: null, taxBase: null }
	};
}

/** The draft as the pool estimate reads it: the recognized role, grade, skills and range, the vacancy not saved yet. */
export function unsavedVacancyOf(
	draft: Pick<VacancyTextDraft, 'fields' | 'blocks' | 'taxonomyVersionId'>
): UnsavedVacancy {
	const { fields } = draft;
	return {
		...positionInput(fields),
		requiredSkillKeys: fields.requiredSkills.flatMap((skill) => (skill.key === null ? [] : [skill.key])),
		title: fields.title?.value ?? '',
		description: draft.blocks.map((block) => block.text).join('\n'),
		niceSkillKeys: fields.niceSkills.flatMap((skill) => (skill.key === null ? [] : [skill.key])),
		workFormat: fields.workFormat?.value ?? null,
		taxonomyVersionId: draft.taxonomyVersionId
	};
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Parses pasted vacancy text for the company of the author, an admitted one: a company that may not save a vacancy
 * does not spend the model on its draft. The call is interactive: the employer waits; the same text parsed again
 * gets the answer the model gave (`extractPastedText`). Any model failure gives the rules mode with its reason; the
 * envelope records what happened either way.
 */
export async function extractVacancyFromText(
	deps: VacancyTextDeps,
	author: { companyId: string },
	text: string,
	signal?: AbortSignal
): Promise<VacancyTextDraft> {
	const trimmed = text.trim();
	if (trimmed.length === 0) throw invalid('text', 'the text is empty');
	if (trimmed.length > VACANCY_TEXT_MAX_LENGTH) throw invalid('text', 'the text is too long');
	await requireAdmission(deps.db, author.companyId);
	const blocks = textBlocks(trimmed);
	const taxonomy = await loadVacancyTaxonomy(deps.db);
	const lexicon = vacancyLexicon(taxonomy);
	const vacancyId = uuidv7();
	const inputRef = { type: 'vacancy', id: vacancyId, revision: 0, company_id: author.companyId };
	const inputSha256 = sha256(trimmed);

	const response = await extractPastedText(
		deps,
		{ companyId: author.companyId, inputSha256, inputId: vacancyId, taxonomyVersionId: taxonomy.id, blocks },
		lexicon,
		signal ? { signal } : {}
	);

	const envelope = {
		operation: 'extract' as const,
		inputRef,
		inputSha256,
		inputVersion: '0',
		schemaVersion: VACANCY_SCHEMA_VERSION,
		taxonomyVersionId: taxonomy.id
	};
	const toFields = (items: readonly VacancyItem[]) =>
		fieldsFromItems(
			items,
			blocks,
			(raw) => resolveSkill(taxonomy, raw),
			(title) => roleOfTitle(title, taxonomy.roleNames)
		);
	let fields: VacancyTextFields;
	let values: typeof mlResults.$inferInsert;
	if (response.ok) {
		fields = toFields(response.value.items);
		values = {
			...envelope,
			model: extractModelEnvelope(response.value.model),
			processingMode: 'model',
			rejectedItems: response.value.rejectedReasons.map((reason) => ({ reason })),
			latencyMs: response.value.latencyMs
		};
	} else {
		const started = Date.now();
		const checked = extractVacancyByRules(blocks, taxonomy, lexicon);
		fields = toFields(checked.items);
		values = {
			...envelope,
			rulesVersion: VACANCY_TEXT_RULES_VERSION,
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

	return {
		vacancyId,
		mlResultId: row.id,
		mode: response.ok ? 'model' : 'rules',
		modelFailure: response.ok ? null : response.error.code,
		blocks,
		fields,
		missing: missingFields(fields),
		textCheck: checkVacancyText({ text: trimmed }),
		marketPosition: await vacancyMarketPosition(deps.db, positionInput(fields), new Date()),
		taxonomyVersionId: taxonomy.id
	};
}
