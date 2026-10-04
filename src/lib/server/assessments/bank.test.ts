import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ASSESSMENT_LEVELS, readAssessmentBank, type BankEntry, type QuizItem } from './bank';

const BANK_DIR = fileURLToPath(new URL('../../../../assessments', import.meta.url));
const SKILLS_FILE = fileURLToPath(new URL('../../../../taxonomy/skills.json', import.meta.url));

let bank: BankEntry[];
let taxonomySkills: Set<string>;

beforeAll(async () => {
	bank = await readAssessmentBank(BANK_DIR);
	const skills = JSON.parse(await readFile(SKILLS_FILE, 'utf8')) as { skills: { key: string }[] };
	taxonomySkills = new Set(skills.skills.map((skill) => skill.key));
});

function itemsOf(entry: BankEntry): QuizItem[] {
	if (entry.itemBank.type !== 'adaptive_quiz') throw new Error(`${entry.key} is not a quiz`);
	return entry.itemBank.items;
}

const quizzes = () => bank.filter((entry) => entry.kind === 'quiz');

describe('assessment bank', () => {
	it('confirms only skills of the taxonomy', () => {
		for (const entry of bank) {
			for (const skillKey of entry.skillKeys)
				expect(taxonomySkills.has(skillKey), `${entry.key}: ${skillKey}`).toBe(true);
		}
	});

	it('has one quiz per skill', () => {
		const skills = quizzes().flatMap((quiz) => quiz.skillKeys);
		expect(new Set(skills).size).toBe(skills.length);
	});

	it('gives every quiz question exactly one right answer among distinct options', () => {
		for (const quiz of quizzes()) {
			for (const item of itemsOf(quiz)) {
				const texts = item.options.map((option) => option.text.trim());
				expect(new Set(texts).size, item.id).toBe(texts.length);
				expect(
					item.options.filter((option) => option.id === item.correct),
					item.id
				).toHaveLength(1);
				expect(item.explanation.length, item.id).toBeGreaterThan(20);
			}
		}
	});

	it('keeps item ids unique across the bank', () => {
		const ids = quizzes().flatMap((quiz) => itemsOf(quiz).map((item) => item.id));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('orders the difficulties by level, so the adaptive walk moves between levels', () => {
		for (const quiz of quizzes()) {
			const items = itemsOf(quiz);
			const bands = ASSESSMENT_LEVELS.map((level) => items.filter((item) => item.level === level));
			for (let index = 1; index < bands.length; index++) {
				const lower = Math.max(...(bands[index - 1] ?? []).map((item) => item.difficulty));
				const upper = Math.min(...(bands[index] ?? []).map((item) => item.difficulty));
				expect(lower, `${quiz.key}: ${ASSESSMENT_LEVELS[index]}`).toBeLessThan(upper);
			}
		}
	});

	it('does not give the answer away by its position', () => {
		for (const quiz of quizzes()) {
			const items = itemsOf(quiz);
			const counts = new Map<string, number>();
			for (const item of items) counts.set(item.correct, (counts.get(item.correct) ?? 0) + 1);
			expect(Math.max(...counts.values()), quiz.key).toBeLessThanOrEqual(items.length / 2);
		}
	});

	it('does not give the answer away by its length', () => {
		for (const quiz of quizzes()) {
			const items = itemsOf(quiz);
			let longest = 0;
			for (const item of items) {
				const right = item.options.find((option) => option.id === item.correct)?.text.length ?? 0;
				const others = Math.max(
					...item.options.filter((option) => option.id !== item.correct).map((option) => option.text.length)
				);
				// A right answer much longer than every other option is picked without knowing the subject.
				expect(right, item.id).toBeLessThanOrEqual(others * 1.35);
				if (right > others) longest++;
			}
			expect(longest, quiz.key).toBeLessThanOrEqual(items.length / 2);
		}
	});
});

describe('assessment bank validation', () => {
	/** Reads a bank of the Go quiz alone, with its first question changed by `change`. */
	async function bankWith(change: (item: QuizItem) => void): Promise<BankEntry[]> {
		const directory = await mkdtemp(join(tmpdir(), 'bank-'));
		try {
			await mkdir(join(directory, 'code'));
			await mkdir(join(directory, 'quiz'));
			const quiz = JSON.parse(await readFile(join(BANK_DIR, 'quiz', 'quiz-go.json'), 'utf8')) as {
				items: QuizItem[];
			};
			const [first] = quiz.items;
			if (!first) throw new Error('the Go quiz has no questions');
			change(first);
			await writeFile(join(directory, 'quiz', 'quiz-go.json'), JSON.stringify(quiz));
			return await readAssessmentBank(directory);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	it('reads an unchanged quiz', async () => {
		await expect(bankWith(() => {})).resolves.toHaveLength(1);
	});

	it('refuses a question whose options repeat, since the key would be ambiguous', async () => {
		const read = bankWith((item) => {
			const [first, second] = item.options;
			if (!first || !second) throw new Error('a question needs options');
			second.text = ` ${first.text} `;
		});
		await expect(read).rejects.toThrow(/quiz-go-01: option texts repeat/);
	});

	it('refuses a right answer that is not among the options', async () => {
		await expect(
			bankWith((item) => {
				item.correct = 'f';
			})
		).rejects.toThrow(/the correct option is not among the options/);
	});

	it('refuses an item id outside the namespace of its quiz', async () => {
		await expect(
			bankWith((item) => {
				item.id = 'quiz-python-01';
			})
		).rejects.toThrow(/an item id starts with the quiz key/);
	});
});
