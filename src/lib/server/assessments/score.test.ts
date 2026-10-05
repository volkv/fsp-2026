import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { clampHarness, fixtureFamilies } from '../../../../tests/helpers/families';
import type { RunResponse } from '../sandbox/types';
import {
	SandboxFailure,
	shareDown,
	answerMatches,
	groupsScore,
	harnessLine,
	mutantRubricScore,
	practiceRunRequest,
	qaCasesStdin,
	qaScore,
	withChangeStep
} from './score';

describe('computed answers', () => {
	it('compares by the kind of the key', () => {
		expect(answerMatches({ kind: 'exact', value: '42' }, ' 42 ')).toBe(true);
		expect(answerMatches({ kind: 'exact', value: '42' }, '42.0')).toBe(false);
		expect(answerMatches({ kind: 'tokens', value: 'a  b\nc' }, 'a b c')).toBe(true);
		expect(answerMatches({ kind: 'float_eps', value: 0.75, eps: 0.01 }, '0,755')).toBe(true);
		expect(answerMatches({ kind: 'float_eps', value: 0.75, eps: 0.01 }, 'около 0.75')).toBe(false);
		expect(answerMatches({ kind: 'line_no', value: 7 }, '7')).toBe(true);
		expect(answerMatches({ kind: 'line_no', value: 7 }, '7a')).toBe(false);
		expect(answerMatches({ kind: 'set', value: ['b', 'a'] }, 'a\nb\n')).toBe(true);
		expect(answerMatches({ kind: 'set', value: ['b', 'a'] }, ['a'])).toBe(false);
		expect(answerMatches({ kind: 'sequence', value: ['b', 'a'] }, ['a', 'b'])).toBe(false);
		expect(answerMatches({ kind: 'sequence', value: ['b', 'a'] }, 'b\na')).toBe(true);
	});
});

const family = fixtureFamilies('backend').find(
	(f) => f.descriptor.format === 'practice_code' && f.descriptor.changeStep
);
if (!family) throw new Error('no practice family');
const instance = family.module.generate({ seed: 'p1', grade: 'middle', classId: 'a' });

function response(verdicts: Record<string, RunResponse['tests'][number]['verdict']>): RunResponse {
	return {
		requestId: 'r',
		engine: { name: 'go-judge', version: '1' },
		language: { key: 'python3', version: '3.12' },
		compile: null,
		tests: Object.entries(verdicts).map(([id, verdict]) => ({
			id,
			verdict,
			cpuTimeMs: 1,
			wallTimeMs: 1,
			memoryKb: 1,
			exitCode: 0,
			signal: null,
			stdoutSha256: '0'.repeat(64),
			stdoutPreview: null
		}))
	};
}

describe('practice', () => {
	const groups = instance.practice?.groups ?? [];

	it('sends every test of every group in one request under `<group>/<n>`', () => {
		const request = practiceRunRequest('req-1', instance, groups, 'python3', 'print(1)');
		expect(request.tests.map((t) => t.id)).toEqual([
			'g1/1',
			'g1/2',
			'g2/1',
			'g2/2',
			'g3/1',
			'g3/2',
			'g4/1',
			'g4/2',
			'g5/1',
			'g5/2'
		]);
		expect(request.tests.every((t) => t.hidden)).toBe(true);
		expect(request.checker).toEqual({ kind: 'tokens' });
	});

	it('scores the share of groups whose every test passed', () => {
		const verdicts = Object.fromEntries(
			practiceRunRequest('r', instance, groups, 'python3', 'x').tests.map((t) => [t.id, 'accepted' as const])
		);
		expect(groupsScore(groups, response(verdicts)).score).toBe(1);
		expect(groupsScore(groups, response({ ...verdicts, 'g2/2': 'wrong_answer', 'g3/1': 'time_limit' })).score).toBe(
			0.6
		);
		// Rubrics round down to the scale of 1/20.
		expect(shareDown(2, 3)).toBe(0.65);
		expect(shareDown(1, 7)).toBe(0.1);
		expect(() => groupsScore(groups, response({ ...verdicts, 'g1/1': 'sandbox_error' }))).toThrow(SandboxFailure);
	});

	it('folds the step «измени своё решение» into its task', () => {
		expect(withChangeStep(1, 0, 0.3)).toBe(0.7);
		expect(withChangeStep(0.5, 1, 0.3)).toBe(0.65);
		// ⌊(14·13 + 6·20) / 20⌋ = ⌊15.1⌋ = 15 twentieths.
		expect(withChangeStep(0.65, 1, 0.3)).toBe(0.75);
		expect(() => withChangeStep(0.66, 1, 0.3)).toThrow(/1\/20/);
	});
});

describe('QA against mutants', () => {
	const qaFamily = fixtureFamilies('qa').find((f) => f.descriptor.format === 'qa_mutation');
	if (!qaFamily) throw new Error('no QA family');
	const qa = qaFamily.module.generate({ seed: 'q1', grade: 'junior', classId: 'a' });
	const rubric = qaFamily.descriptor.rubric;
	if (rubric.kind !== 'mutants') throw new Error('rubric');

	const run = (mode: 'reference' | 'mutants', cases: { input: string; expected: string }[]): string =>
		execFileSync('python3', ['-c', clampHarness(qa, mode).source], { input: qaCasesStdin(cases) })
			.toString()
			.trim();

	it('maps the kill ratio to the highest rubric level reached', () => {
		expect(mutantRubricScore(rubric, 0.4)).toBe(0);
		expect(mutantRubricScore(rubric, 0.5)).toBe(0.5);
		expect(mutantRubricScore(rubric, 0.8)).toBe(1);
	});

	it('kills mutants with boundary cases and leaves the equivalent one out of the denominator', () => {
		const cases = [
			{ input: '5 1 9', expected: '5' },
			{ input: '0 1 9', expected: '1' },
			{ input: '10 1 9', expected: '9' },
			{ input: '8 1 9', expected: '8' },
			{ input: '1 1 9', expected: '1' }
		];
		const reference = run('reference', cases);
		expect(reference).toBe('11111');
		const mutants = run('mutants', cases);
		expect(mutants).toBe('111110');
		const score = qaScore(qa, rubric, reference, mutants);
		expect(score).toMatchObject({ outcome: 'scored', killed: 5, nonEquivalent: 5, killRatio: 1, score: 1 });
		const weak = cases.slice(0, 1).concat({ input: '6 1 9', expected: '6' }, { input: '7 1 9', expected: '7' });
		const weakScore = qaScore(qa, rubric, run('reference', weak), run('mutants', weak));
		expect(weakScore.killRatio).toBeCloseTo(0.2);
		expect(weakScore.score).toBe(0);
	});

	it('gives 0 to a set that fails on the correct program', () => {
		const cases = [{ input: '5 1 9', expected: '6' }];
		const reference = run('reference', cases);
		expect(reference).toBe('0');
		expect(qaScore(qa, rubric, reference, null)).toMatchObject({ outcome: 'invalid_against_reference', score: 0 });
		// Even with every mutant killed, one case failing on the reference voids the set.
		expect(qaScore(qa, rubric, '01111', '111110')).toMatchObject({ outcome: 'invalid_against_reference', score: 0 });
	});

	it('treats a harness that did not finish as a failure of the run, not a verdict', () => {
		const ok = response({ harness: 'wrong_answer' });
		const first = ok.tests[0];
		if (!first) throw new Error('test');
		first.stdoutPreview = '1101\n';
		expect(harnessLine(ok, 4)).toBe('1101');
		expect(() => harnessLine(response({ harness: 'time_limit' }), 4)).toThrow(SandboxFailure);
		expect(() => harnessLine(ok, 5)).toThrow(SandboxFailure);
	});
});

describe('QA step «измени своё решение»', () => {
	const qaFamily = fixtureFamilies('qa').find(
		(f) => f.descriptor.format === 'qa_mutation' && f.descriptor.changeStep !== null
	);
	if (!qaFamily) throw new Error('no QA family with a step');
	const instance = qaFamily.module.generate({ seed: 'q2', grade: 'middle', classId: 'a' });
	const rubric = qaFamily.descriptor.rubric;

	it('runs the changed specification against its own mutants', () => {
		const cases = [
			{ input: '5 9 1', expected: '5' },
			{ input: '0 9 1', expected: '1' },
			{ input: '10 1 9', expected: '9' },
			{ input: '8 1 9', expected: '8' },
			{ input: '1 1 9', expected: '1' }
		];
		const run = (mode: 'reference' | 'mutants') =>
			execFileSync('python3', ['-c', clampHarness(instance, mode, 'change_step').source], {
				input: qaCasesStdin(cases)
			})
				.toString()
				.trim();
		const reference = run('reference');
		expect(reference).toBe('11111');
		const score = qaScore(instance, rubric, reference, run('mutants'), 'change_step');
		expect(score.nonEquivalent).toBe(6);
		expect(score.outcome).toBe('scored');
	});
});
