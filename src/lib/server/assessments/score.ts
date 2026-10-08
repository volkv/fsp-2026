// Scores of clusters (docs/domain.md, 10.3; docs/contracts.md, 6.5): a computed answer against the generator's key, a
// program against the hidden test groups of its instance, QA test cases against the reference and the mutants, and the
// step «измени своё решение» folded into its task. Every score is a multiple of 1/20, rounded down (the scale of the
// procedure). Pure functions over the instance and the sandbox's answer; a failure of the sandbox is never a score.
import {
	answerItem,
	type ComputedAnswer,
	type HiddenTestGroup,
	type ItemInstance,
	type Rubric
} from './contract/bank.ts';
import { SCALE, twentieths } from './contract/procedure.ts';
import type { RunLimits, RunRequest, RunResponse } from '../sandbox/types.ts';

/** What the candidate typed: one value, or the items of a set or a sequence (one per line in the form). */
export type CandidateAnswer = string | readonly string[];

/** The items of a set or a sequence the candidate typed, each in the compared form (`answerItem`); blank lines dropped. */
const lines = (value: CandidateAnswer): string[] =>
	(typeof value === 'string' ? value.split(/\r?\n/) : [...value]).map(answerItem).filter((item) => item !== '');

const single = (value: CandidateAnswer): string => (typeof value === 'string' ? value : value.join('\n')).trim();

const parseNumber = (text: string): number | null => {
	const normalized = text.trim().replace(',', '.');
	if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(normalized)) return null;
	return Number(normalized);
};

/** Whether the candidate's answer matches the key; the key is computed by the generator, never shown. */
export function answerMatches(expected: ComputedAnswer, given: CandidateAnswer): boolean {
	switch (expected.kind) {
		case 'exact':
			return single(given).replace(/\r\n/g, '\n') === expected.value.trim().replace(/\r\n/g, '\n');
		case 'tokens': {
			const tokens = (text: string) => text.split(/\s+/).filter((t) => t !== '');
			const left = tokens(single(given));
			const right = tokens(expected.value);
			return left.length === right.length && left.every((t, i) => t === right[i]);
		}
		case 'float_eps': {
			const value = parseNumber(single(given));
			return value !== null && Math.abs(value - expected.value) <= expected.eps;
		}
		case 'line_no': {
			const text = single(given);
			if (!/^\d+$/.test(text)) return false;
			const line = Number(text);
			return line === expected.value || (expected.alternatives ?? []).includes(line);
		}
		case 'set': {
			const left = new Set(lines(given));
			const right = new Set(expected.value.map(answerItem));
			return left.size === right.size && [...left].every((item) => right.has(item));
		}
		case 'sequence': {
			const left = lines(given);
			const right = expected.value.map(answerItem);
			return left.length === right.length && left.every((item, i) => item === right[i]);
		}
	}
}

/** Default limits of a practice run (docs/contracts.md, 6.2); an instance does not carry its own. */
export const PRACTICE_LIMITS: RunLimits = {
	cpuTimeMs: 2_000,
	wallTimeMs: 5_000,
	memoryMb: 256,
	outputKb: 64,
	processes: 1,
	compileCpuTimeMs: 10_000,
	compileMemoryMb: 512
};

/** The id of the n-th test of a group in a run request: `<group>/<n>`. */
export const testId = (group: string, n: number): string => `${group}/${n}`;

/** One submission — one request with every test of every group (≤ 50, contracts 6.5). */
export function practiceRunRequest(
	requestId: string,
	instance: ItemInstance,
	groups: readonly HiddenTestGroup[],
	language: string,
	source: string
): RunRequest {
	if (!instance.practice) throw new Error(`instance ${instance.family}/${instance.seed} is not a practice task`);
	return {
		requestId,
		language,
		source,
		tests: groups.flatMap((group) =>
			group.tests.map((test, i) => ({
				id: testId(group.id, i + 1),
				stdin: test.stdin,
				expected: test.expected,
				hidden: true
			}))
		),
		limits: PRACTICE_LIMITS,
		checker: instance.practice.checker
	};
}

/** `passed / total` rounded down to 1/20: ⌊20 · passed / total⌋ / 20. */
export function shareDown(passed: number, total: number): number {
	if (total <= 0) throw new Error('a share of nothing');
	return Math.floor((SCALE * passed) / total) / SCALE;
}

/** A run whose verdicts are not the program's: the cluster waits for a retry (contracts 6.4). */
export class SandboxFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SandboxFailure';
	}
}

export interface GroupsScore {
	score: number;
	passedGroups: number;
	totalGroups: number;
	groups: { id: string; passed: boolean; passedTests: number; tests: number }[];
}

/** The share of groups whose every test is `accepted`; a sandbox error on any test is not a verdict. */
export function groupsScore(groups: readonly HiddenTestGroup[], response: RunResponse): GroupsScore {
	if (response.tests.some((test) => test.verdict === 'sandbox_error')) {
		throw new SandboxFailure('the sandbox failed to run a test');
	}
	const verdicts = new Map(response.tests.map((test) => [test.id, test.verdict]));
	const results = groups.map((group) => {
		let passedTests = 0;
		group.tests.forEach((_, i) => {
			const verdict = verdicts.get(testId(group.id, i + 1));
			if (verdict === undefined) throw new SandboxFailure(`the response lacks test ${testId(group.id, i + 1)}`);
			if (verdict === 'accepted') passedTests += 1;
		});
		return { id: group.id, passed: passedTests === group.tests.length, passedTests, tests: group.tests.length };
	});
	const passedGroups = results.filter((g) => g.passed).length;
	return {
		score: shareDown(passedGroups, groups.length),
		passedGroups,
		totalGroups: groups.length,
		groups: results
	};
}

export interface QaCase {
	input: string;
	expected: string;
}

/** The test cases of a QA cluster go to the harness as JSON on its standard input. */
export const qaCasesStdin = (cases: readonly QaCase[]): string => JSON.stringify(cases);

/** Limits of a harness run: the wall time grows with the number of mutants, up to the bound of the contract. */
export function harnessLimits(mutants: number): RunLimits {
	return { ...PRACTICE_LIMITS, cpuTimeMs: 10_000, wallTimeMs: Math.min(20_000, 5_000 + 1_000 * mutants) };
}

/**
 * The one line a harness prints, read from the preview of its only test. Any verdict other than a finished run
 * (`accepted` or `wrong_answer` — the harness's line is compared with nothing it knows) is a failure of the run.
 */
export function harnessLine(response: RunResponse, length: number): string {
	const test = response.tests[0];
	if (response.compile && response.compile.status !== 'ok') throw new SandboxFailure('the harness did not compile');
	if (!test || (test.verdict !== 'accepted' && test.verdict !== 'wrong_answer') || test.skipped) {
		throw new SandboxFailure(`the harness run ended with ${test?.verdict ?? 'no test'}`);
	}
	const line = (test.stdoutPreview ?? '').trim();
	if (line.length !== length || !/^[01]*$/.test(line))
		throw new SandboxFailure('the harness printed an unreadable line');
	return line;
}

export interface QaScore {
	score: number;
	/** `invalid_against_reference` — a case fails on the correct program: the set proves nothing (domain 10.3). */
	outcome: 'scored' | 'invalid_against_reference';
	casesOnReference: string;
	killed: number;
	nonEquivalent: number;
	killRatio: number;
	matrix: { id: string; equivalent: boolean; killed: boolean }[];
}

/** The rubric level of a kill ratio: the highest level whose `minKillRatio` is reached; below the first — 0. */
export function mutantRubricScore(rubric: Extract<Rubric, { kind: 'mutants' }>, ratio: number): number {
	let score = 0;
	for (const level of rubric.levels) if (ratio + 1e-12 >= level.minKillRatio) score = Math.max(score, level.score);
	return score;
}

/**
 * The score of QA test cases from the two harness lines; equivalent mutants are outside the denominator. `part` — the task
 * or the step «измени своё решение» with its own mutants.
 */
export function qaScore(
	instance: ItemInstance,
	rubric: Rubric,
	referenceLine: string,
	mutantLine: string | null,
	part: 'task' | 'change_step' = 'task'
): QaScore {
	const qa = part === 'task' ? instance.qa : instance.changeStep?.qa;
	if (!qa) throw new Error(`instance ${instance.family}/${instance.seed} has no QA ${part}`);
	if (rubric.kind !== 'mutants') throw new Error(`family ${instance.family} has no mutant rubric`);
	const base = { casesOnReference: referenceLine };
	if (referenceLine.includes('0') || mutantLine === null) {
		return {
			...base,
			score: 0,
			outcome: 'invalid_against_reference',
			killed: 0,
			nonEquivalent: 0,
			killRatio: 0,
			matrix: []
		};
	}
	const matrix = qa.mutants.map((m, i) => ({
		id: m.id,
		equivalent: m.equivalent,
		killed: mutantLine[i] === '1'
	}));
	const counted = matrix.filter((m) => !m.equivalent);
	const killed = counted.filter((m) => m.killed).length;
	const killRatio = counted.length === 0 ? 0 : killed / counted.length;
	return {
		...base,
		score: mutantRubricScore(rubric, killRatio),
		outcome: 'scored',
		killed,
		nonEquivalent: counted.length,
		killRatio,
		matrix
	};
}

/** A practice cluster with the step «измени своё решение»: ⌊(20 − w₂₀)·s₂₀task + w₂₀·s₂₀step⌋ / 20, in twentieths. */
export function withChangeStep(taskScore: number, stepScore: number, weight: number): number {
	const w = twentieths(weight, 'change step weight');
	const task = twentieths(taskScore, 'task score');
	const step = twentieths(stepScore, 'step score');
	return Math.floor(((SCALE - w) * task + w * step) / SCALE) / SCALE;
}
