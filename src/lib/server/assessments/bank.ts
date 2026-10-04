// The bank of platform assessments (docs/domain.md, section 10): practical code tasks and adaptive quizzes kept as files
// in `assessments/`, validated and turned into the exact rows of `assessment_versions`. The same schemas read those
// rows back, so what the service judges by is what the bank declared.
// Imported by plain Node (scripts/seed-assessments.ts): relative imports with extensions, erasable syntax only.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../json/canonical.ts';
import { runRequestSchema } from '../sandbox/request.ts';
import { parseStatement, StatementError } from './statement.ts';

/** Levels an assessment confirms; the same keys as the grades of the taxonomy they may cap (domain 9.3, 12). */
export const ASSESSMENT_LEVELS = ['junior', 'middle', 'senior'] as const;
export type AssessmentLevel = (typeof ASSESSMENT_LEVELS)[number];

/**
 * Languages of the sandbox image with the file each one compiles (services/sandbox/languages.json). The image stays the
 * source of truth at run time: a language it lacks fails the run as a configuration error of the task.
 */
export const SOURCE_FILES = {
	python3: 'main.py',
	javascript: 'main.js',
	typescript: 'main.ts',
	go: 'main.go',
	cpp17: 'main.cpp',
	java21: 'Main.java'
} as const;
export type SandboxLanguageKey = keyof typeof SOURCE_FILES;
const LANGUAGE_KEYS = Object.keys(SOURCE_FILES) as [SandboxLanguageKey, ...SandboxLanguageKey[]];

export class AssessmentBankError extends Error {
	readonly code: 'invalid_bank' | 'version_changed' | 'version_regressed' | 'kind_changed';

	constructor(code: AssessmentBankError['code'], message: string) {
		super(message);
		this.name = 'AssessmentBankError';
		this.code = code;
	}
}

const bankKey = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const skillKey = z.string().regex(/^[a-z][a-z0-9_]*$/);
const text = z.string().trim().min(1);
const strength = z.number().gt(0).max(1);

// --- Stored shapes (jsonb of assessment_versions) -----------------------------------------------------------------

export const coverageSchema = z.strictObject({
	/** Skills a successful attempt confirms and at which levels; `languages` — only when solved in one of them. */
	skills: z
		.array(
			z.strictObject({
				skillKey,
				levels: z.array(z.enum(ASSESSMENT_LEVELS)).min(1),
				languages: z.array(z.enum(LANGUAGE_KEYS)).min(1).optional()
			})
		)
		.min(1),
	checks: z.array(text).min(1),
	doesNotCheck: z.array(text).min(1),
	notes: z.array(text).optional()
});
export type Coverage = z.infer<typeof coverageSchema>;

const limitsSchema = z.strictObject({
	cpuTimeMs: z.int(),
	wallTimeMs: z.int(),
	memoryMb: z.int(),
	outputKb: z.int(),
	processes: z.int(),
	compileCpuTimeMs: z.int(),
	compileMemoryMb: z.int()
});

const checkerSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('exact') }),
	z.strictObject({ kind: z.literal('tokens') }),
	z.strictObject({ kind: z.literal('float_eps'), eps: z.number().positive().max(1) })
]);

const timeLimitMinutes = z.int().min(5).max(240);

export const codeScorerSchema = z.strictObject({
	type: z.literal('sandbox_judge'),
	version: z.literal('1'),
	timeLimitMinutes,
	languages: z.array(z.enum(LANGUAGE_KEYS)).min(1),
	limits: limitsSchema,
	checker: checkerSchema,
	tests: z
		.array(
			z.strictObject({
				id: z.string().regex(/^[a-z0-9-]+$/),
				stdin: z.string(),
				expected: z.string(),
				hidden: z.boolean()
			})
		)
		.min(2)
});
export type CodeScorer = z.infer<typeof codeScorerSchema>;

export const quizScorerSchema = z.strictObject({
	type: z.literal('key'),
	version: z.literal('1'),
	timeLimitMinutes
});
export type QuizScorer = z.infer<typeof quizScorerSchema>;

/** Code task: the level of the task is confirmed when the share of passed tests reaches the threshold. */
export const testsPassedScaleSchema = z.strictObject({
	type: z.literal('tests_passed'),
	thresholds: z
		.array(
			z.strictObject({ minRatio: z.number().gt(0).max(1), level: z.enum(ASSESSMENT_LEVELS), levelStrength: strength })
		)
		.min(1),
	below: z.literal('not_passed')
});

/** Adaptive quiz: the level is the highest cut the ability estimate reaches; a level test gives its grade. */
export const abilityScaleSchema = z.strictObject({
	type: z.literal('ability'),
	cuts: z
		.array(
			z.strictObject({
				level: z.enum(ASSESSMENT_LEVELS),
				minAbility: z.number().min(-4).max(4),
				levelStrength: strength,
				gradeKey: z.enum(ASSESSMENT_LEVELS)
			})
		)
		.min(1),
	below: z.literal('not_confirmed')
});

export const levelScaleSchema = z.discriminatedUnion('type', [testsPassedScaleSchema, abilityScaleSchema]);
export type LevelScale = z.infer<typeof levelScaleSchema>;

export const quizRuleSchema = z.strictObject({
	/** Three-parameter logistic model with one discrimination for all items and guessing 1 / options. */
	model: z.literal('irt_3pl'),
	discrimination: z.number().positive().max(4),
	guessing: z.literal('one_over_options'),
	estimator: z.literal('eap'),
	prior: z.strictObject({ mean: z.number().min(-2).max(2), sd: z.number().positive().max(3) }),
	grid: z.strictObject({ from: z.number(), to: z.number(), step: z.number().positive() }),
	selection: z.literal('max_information'),
	stop: z.strictObject({
		minItems: z.int().positive(),
		maxItems: z.int().positive(),
		maxStandardError: z.number().positive()
	})
});
export type QuizRule = z.infer<typeof quizRuleSchema>;

const optionId = z.string().regex(/^[a-z]$/);

export const quizItemSchema = z.strictObject({
	id: z.string().regex(/^[a-z0-9-]+$/),
	version: z.int().positive(),
	level: z.enum(ASSESSMENT_LEVELS),
	/** Difficulty on the ability scale, set by the author; not yet calibrated on answers. */
	difficulty: z.number().min(-4).max(4),
	prompt: text,
	code: z.string().min(1).optional(),
	options: z
		.array(z.strictObject({ id: optionId, text }))
		.min(2)
		.max(6),
	correct: optionId,
	explanation: text
});
export type QuizItem = z.infer<typeof quizItemSchema>;

export const codeItemBankSchema = z.strictObject({
	type: z.literal('code_statement'),
	key: bankKey,
	summary: text,
	stack: skillKey,
	level: z.enum(ASSESSMENT_LEVELS),
	/** The statement in the restricted Markdown of `statement.ts`. */
	statement: text
});

export const quizItemBankSchema = z.strictObject({
	type: z.literal('adaptive_quiz'),
	key: bankKey,
	summary: text,
	rule: quizRuleSchema,
	items: z.array(quizItemSchema).min(1)
});

export const itemBankSchema = z.discriminatedUnion('type', [codeItemBankSchema, quizItemBankSchema]);
export type ItemBank = z.infer<typeof itemBankSchema>;

// --- Source files ---------------------------------------------------------------------------------------------------

const codeFileSchema = z.strictObject({
	key: bankKey,
	kind: z.literal('code_task'),
	version: z.int().positive(),
	title: text,
	summary: text,
	stack: skillKey,
	level: z.enum(ASSESSMENT_LEVELS),
	skillKeys: z.array(skillKey).min(1),
	languages: z.array(z.enum(LANGUAGE_KEYS)).min(1),
	timeLimitMinutes,
	limits: limitsSchema,
	checker: checkerSchema,
	levelScale: testsPassedScaleSchema,
	coverage: coverageSchema,
	tests: z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9-]+$/), hidden: z.boolean() })).min(2)
});

const quizFileSchema = z.strictObject({
	key: bankKey,
	kind: z.literal('quiz'),
	version: z.int().positive(),
	title: text,
	summary: text,
	skillKeys: z.array(skillKey).min(1),
	timeLimitMinutes,
	rule: quizRuleSchema,
	levelScale: abilityScaleSchema,
	coverage: coverageSchema,
	items: z.array(quizItemSchema).min(1)
});

/** One version of one assessment, in the shape of its rows. */
export interface BankEntry {
	key: string;
	kind: 'code_task' | 'quiz';
	version: number;
	title: string;
	skillKeys: string[];
	scorer: CodeScorer | QuizScorer;
	levelScale: LevelScale;
	coverage: Coverage;
	itemBank: ItemBank;
	contentSha256: string;
	/** Reference solutions by language; kept in the repository for checking the bank, never published. */
	references: Partial<Record<SandboxLanguageKey, string>>;
}

export function assessmentContentSha256(
	entry: Pick<BankEntry, 'kind' | 'title' | 'skillKeys' | 'scorer' | 'levelScale' | 'coverage' | 'itemBank'>
): string {
	const content = canonicalJson({
		kind: entry.kind,
		title: entry.title,
		skillKeys: entry.skillKeys,
		scorer: entry.scorer,
		levelScale: entry.levelScale,
		coverage: entry.coverage,
		itemBank: entry.itemBank
	});
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

function invalid(where: string, message: string): AssessmentBankError {
	return new AssessmentBankError('invalid_bank', `${where}: ${message}`);
}

function parse<S extends z.ZodType>(schema: S, value: unknown, where: string): z.infer<S> {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`);
		throw invalid(where, issues.join('; '));
	}
	return parsed.data;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
	new Set(a).size === a.length && a.length === new Set(b).size && a.every((value) => b.includes(value));

function checkCoverage(where: string, skillKeys: string[], coverage: Coverage, languages: readonly string[] | null) {
	if (
		!sameSet(
			skillKeys,
			coverage.skills.map((skill) => skill.skillKey)
		)
	) {
		throw invalid(where, 'skillKeys must list exactly the skills of the coverage, once each');
	}
	for (const skill of coverage.skills) {
		if (skill.languages && (languages === null || skill.languages.some((language) => !languages.includes(language)))) {
			throw invalid(where, `coverage of ${skill.skillKey} names a language the assessment does not accept`);
		}
	}
}

function checkAscending(where: string, values: number[], name: string) {
	for (let index = 1; index < values.length; index++) {
		if ((values[index] ?? 0) <= (values[index - 1] ?? 0)) throw invalid(where, `${name} must strictly increase`);
	}
}

async function readCodeTask(directory: string, name: string): Promise<BankEntry> {
	const where = `code/${name}`;
	const file = parse(codeFileSchema, JSON.parse(await readFile(join(directory, 'assessment.json'), 'utf8')), where);
	if (file.key !== name) throw invalid(where, `key ${file.key} differs from the directory name`);
	checkCoverage(where, file.skillKeys, file.coverage, file.languages);
	checkAscending(
		where,
		file.levelScale.thresholds.map((threshold) => threshold.minRatio),
		'thresholds'
	);
	if (!file.coverage.skills.some((skill) => skill.skillKey === file.stack)) {
		throw invalid(where, `the stack ${file.stack} is not among the covered skills`);
	}
	if (!file.tests.some((test) => !test.hidden) || !file.tests.some((test) => test.hidden)) {
		throw invalid(where, 'a task needs open tests to show and hidden tests to judge');
	}
	const tests = [];
	for (const test of file.tests) {
		tests.push({
			id: test.id,
			stdin: await readFile(join(directory, 'tests', `${test.id}.in`), 'utf8'),
			expected: await readFile(join(directory, 'tests', `${test.id}.out`), 'utf8'),
			hidden: test.hidden
		});
	}
	const references: BankEntry['references'] = {};
	for (const language of file.languages) {
		const source = await readFile(join(directory, 'reference', SOURCE_FILES[language]), 'utf8');
		// The tests, limits and checker must form a request the sandbox accepts (docs/contracts.md, 6.1–6.2).
		parse(
			runRequestSchema,
			{ requestId: 'bank', language, source, tests, limits: file.limits, checker: file.checker },
			`${where} (${language})`
		);
		references[language] = source;
	}
	const scorer: CodeScorer = {
		type: 'sandbox_judge',
		version: '1',
		timeLimitMinutes: file.timeLimitMinutes,
		languages: file.languages,
		limits: file.limits,
		checker: file.checker,
		tests
	};
	const statement = await readFile(join(directory, 'statement.md'), 'utf8');
	try {
		parseStatement(statement);
	} catch (error) {
		if (error instanceof StatementError) throw invalid(`${where}/statement.md`, error.message);
		throw error;
	}
	const itemBank: ItemBank = {
		type: 'code_statement',
		key: file.key,
		summary: file.summary,
		stack: file.stack,
		level: file.level,
		statement
	};
	const entry = {
		key: file.key,
		kind: 'code_task' as const,
		version: file.version,
		title: file.title,
		skillKeys: file.skillKeys,
		scorer,
		levelScale: file.levelScale,
		coverage: file.coverage,
		itemBank
	};
	return { ...entry, contentSha256: assessmentContentSha256(entry), references };
}

async function readQuiz(path: string, name: string): Promise<BankEntry> {
	const where = `quiz/${name}`;
	const file = parse(quizFileSchema, JSON.parse(await readFile(path, 'utf8')), where);
	if (`${file.key}.json` !== name) throw invalid(where, `key ${file.key} differs from the file name`);
	checkCoverage(where, file.skillKeys, file.coverage, null);
	checkAscending(
		where,
		file.levelScale.cuts.map((cut) => cut.minAbility),
		'cuts'
	);
	const { stop, grid } = file.rule;
	if (stop.minItems > stop.maxItems) throw invalid(where, 'minItems exceeds maxItems');
	if (file.items.length < stop.maxItems) throw invalid(where, 'the item bank is smaller than maxItems');
	if (grid.from >= grid.to || (grid.to - grid.from) / grid.step > 2000)
		throw invalid(where, 'the ability grid is invalid');
	if (new Set(file.items.map((item) => item.id)).size !== file.items.length) throw invalid(where, 'item ids repeat');
	for (const item of file.items) {
		const ids = item.options.map((option) => option.id);
		if (new Set(ids).size !== ids.length) throw invalid(where, `${item.id}: option ids repeat`);
		if (!ids.includes(item.correct)) throw invalid(where, `${item.id}: the correct option is not among the options`);
		// Two options with the same text would make the key ambiguous: exactly one option may be right.
		const texts = item.options.map((option) => option.text.trim());
		if (new Set(texts).size !== texts.length) throw invalid(where, `${item.id}: option texts repeat`);
		if (!item.id.startsWith(`${file.key}-`)) throw invalid(where, `${item.id}: an item id starts with the quiz key`);
	}
	const scorer: QuizScorer = { type: 'key', version: '1', timeLimitMinutes: file.timeLimitMinutes };
	const itemBank: ItemBank = {
		type: 'adaptive_quiz',
		key: file.key,
		summary: file.summary,
		rule: file.rule,
		items: file.items
	};
	const entry = {
		key: file.key,
		kind: 'quiz' as const,
		version: file.version,
		title: file.title,
		skillKeys: file.skillKeys,
		scorer,
		levelScale: file.levelScale,
		coverage: file.coverage,
		itemBank
	};
	return { ...entry, contentSha256: assessmentContentSha256(entry), references: {} };
}

/** Reads `code/<key>/` and `quiz/<key>.json` of the bank directory; keys are unique across both. */
export async function readAssessmentBank(directory: string): Promise<BankEntry[]> {
	const entries: BankEntry[] = [];
	const codeDirectory = join(directory, 'code');
	for (const name of (await readdir(codeDirectory)).sort()) {
		entries.push(await readCodeTask(join(codeDirectory, name), name));
	}
	const quizDirectory = join(directory, 'quiz');
	for (const name of (await readdir(quizDirectory)).filter((file) => file.endsWith('.json')).sort()) {
		entries.push(await readQuiz(join(quizDirectory, name), name));
	}
	const keys = entries.map((entry) => entry.key);
	if (new Set(keys).size !== keys.length) throw invalid('bank', 'assessment keys repeat');
	if (entries.length === 0) throw invalid('bank', 'the bank is empty');
	return entries;
}
