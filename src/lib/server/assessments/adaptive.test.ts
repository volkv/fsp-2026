import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { estimateAbility, nextQuizItem, quizFinished, quizLevel, type AnsweredStep } from './adaptive';
import { readAssessmentBank, type BankEntry, type QuizItem } from './bank';

const BANK_DIR = fileURLToPath(new URL('../../../../assessments', import.meta.url));

let quizzes: BankEntry[];

beforeAll(async () => {
	quizzes = (await readAssessmentBank(BANK_DIR)).filter((entry) => entry.kind === 'quiz');
});

type Knows = (item: QuizItem) => boolean;

/** Runs a whole quiz with a candidate who answers by `knows`; a question they do not know is answered wrong. */
function simulate(entry: BankEntry, knows: Knows, seed = 'attempt-1') {
	if (entry.itemBank.type !== 'adaptive_quiz' || entry.levelScale.type !== 'ability') throw new Error('not a quiz');
	const { rule, items } = entry.itemBank;
	const steps: AnsweredStep[] = [];
	for (;;) {
		const estimate = estimateAbility(rule, items, steps);
		const item = nextQuizItem(rule, items, steps, estimate, seed);
		if (!item) {
			expect(quizFinished(rule, items, steps, estimate)).toBe(true);
			return { steps, estimate, level: quizLevel(entry.levelScale, estimate) };
		}
		steps.push({ itemId: item.id, correct: knows(item) });
	}
}

const upTo =
	(level: 'none' | 'junior' | 'middle' | 'senior'): Knows =>
	(item) =>
		level === 'senior' ||
		(level === 'middle' && item.level !== 'senior') ||
		(level === 'junior' && item.level === 'junior');

describe('adaptive quiz', () => {
	it('ships the quizzes of the frequent skills, at least twelve items with three levels each', () => {
		expect(quizzes.map((quiz) => quiz.key).sort()).toEqual([
			'quiz-cpp',
			'quiz-csharp',
			'quiz-docker',
			'quiz-go',
			'quiz-java',
			'quiz-javascript',
			'quiz-kotlin',
			'quiz-linux',
			'quiz-php',
			'quiz-python',
			'quiz-sql',
			'quiz-typescript'
		]);
		for (const quiz of quizzes) {
			if (quiz.itemBank.type !== 'adaptive_quiz') throw new Error('not a quiz');
			expect(quiz.itemBank.items.length).toBeGreaterThanOrEqual(12);
			expect(new Set(quiz.itemBank.items.map((item) => item.level))).toEqual(new Set(['junior', 'middle', 'senior']));
		}
	});

	it.each([
		['none', 'not_confirmed'],
		['junior', 'junior'],
		['middle', 'middle'],
		['senior', 'senior']
	] as const)('converges to the level of a candidate who knows up to %s', (knows, expected) => {
		for (const quiz of quizzes) {
			const result = simulate(quiz, upTo(knows));
			expect(result.level.level, quiz.key).toBe(expected);
			expect(result.steps.length).toBeGreaterThanOrEqual(6);
			expect(result.steps.length).toBeLessThanOrEqual(10);
			expect(result.level.confidence).toBeGreaterThan(0.5);
		}
	});

	it('asks every question once and starts near the middle of the scale', () => {
		for (const quiz of quizzes) {
			const result = simulate(quiz, upTo('middle'));
			expect(new Set(result.steps.map((step) => step.itemId)).size).toBe(result.steps.length);
			if (quiz.itemBank.type !== 'adaptive_quiz') throw new Error('not a quiz');
			const first = quiz.itemBank.items.find((item) => item.id === result.steps[0]?.itemId);
			expect(Math.abs(first?.difficulty ?? 99)).toBeLessThan(1);
		}
	});

	it('follows the answers: a wrong answer lowers the estimate, a right one raises it', () => {
		const [quiz] = quizzes;
		if (quiz?.itemBank.type !== 'adaptive_quiz') throw new Error('not a quiz');
		const { rule, items } = quiz.itemBank;
		const first = items[4]?.id ?? '';
		const right = estimateAbility(rule, items, [{ itemId: first, correct: true }]);
		const wrong = estimateAbility(rule, items, [{ itemId: first, correct: false }]);
		const none = estimateAbility(rule, items, []);
		expect(right.ability).toBeGreaterThan(none.ability);
		expect(wrong.ability).toBeLessThan(none.ability);
		expect(right.standardError).toBeLessThan(none.standardError);
	});

	it('is reproducible within one attempt', () => {
		const [quiz] = quizzes;
		if (!quiz) throw new Error('no quiz');
		const once = simulate(quiz, upTo('junior'), 'attempt-a').steps.map((step) => step.itemId);
		const again = simulate(quiz, upTo('junior'), 'attempt-a').steps.map((step) => step.itemId);
		expect(again).toEqual(once);
	});
});
